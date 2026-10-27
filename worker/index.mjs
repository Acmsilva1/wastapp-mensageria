import { logFailure, sendDiagnostic } from '../lib/diagnostics.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import QRCode from 'qrcode';
import { encryptionKey, encrypt } from '../lib/crypto.mjs';
import { closeRepository, openRepository } from '../lib/open-repository.mjs';
import { recipientAddress, discoverGroups, groupCatalogError } from './group-target.mjs';
import { recipientAccepts } from '../lib/domain.mjs';
import { whatsappOutbound } from '../lib/outbound-message.mjs';
import { resetPairingIfRequested, needsFreshPairing, qrRenewalStalled, removeSessionArtifacts } from './pairing-reset.mjs';
import { applySessionFingerprint, sessionFingerprint } from './session-fingerprint.mjs';
import { VolumeAuth, SESSION_CLIENT_ID } from './volume-auth.mjs';
import { createWaterReplies, callbackConfig, WATER_OPTIONS, WATER_QUESTION } from './water-replies.mjs';
import { serializedId, installSerializedIdCompatibility } from './serialized-id-compat.mjs';
import {createMessageReplacement,revokeBotMessage} from './message-replacement.mjs';
import {createAgentChannel} from './agent-channel.mjs';
import {createWhatsAppPurchases} from './whatsapp-purchases.mjs';
const require = createRequire(import.meta.url);
const { Client, Poll } = require('whatsapp-web.js');

const worker = randomUUID();
const repo = await openRepository();
const key = encryptionKey();
const dataPath = path.resolve(process.env.WHATSAPP_DATA_PATH || '.runtime/whatsapp');
await mkdir(dataPath, { recursive: true, mode: 0o700 });
let client;
let agentChannel;
let ready = false;
let stopping = false;
let heartbeat;
let pairingPoll;
let beating = false;
let activeSend;
let closing;
let lastQRAt = 0;
const abort = new AbortController();
const replacements=createMessageReplacement({repo,worker,revoke:(address,id)=>revokeBotMessage(client,address,id)});

async function close(reason = 'stopped') {
  if (closing) return closing;
  stopping = true;
  ready = false;
  abort.abort();
  clearInterval(pairingPoll);
  closing = (async () => {
    if (activeSend) await Promise.race([activeSend.catch(() => {}), sleep(20000)]);
    try { await client?.destroy(); } catch {}
    clearInterval(heartbeat);
    try {
      await repo.state(worker, 'offline');
      await repo.log(worker, 'worker_stopped', reason);
      await repo.release(worker);
    } catch {}
    try { await closeRepository(); } catch {}
  })();
  return closing;
}
process.on('SIGINT', () => close().then(() => process.exit(0)));
process.on('SIGTERM', () => close().then(() => process.exit(0)));
process.on('unhandledRejection', () => {
  console.error('worker_unhandled_failure');
  close('runtime_failure').finally(() => process.exit(1));
});

async function deliver(job) {
  let sending = false;
  let sendTimer;
  try {
    await repo.heartbeat(worker);
    const recipient = await repo.recipient(job.recipient_id);
    if (!recipientAccepts(recipient, job)) return await repo.finish(worker, job.id, 'cancelled', 'recipient_disabled');
    if(job.event_type==='agent.notice'&&!await agentChannel.authorizeDelivery(job,recipient))return await repo.finish(worker,job.id,'cancelled','agent_request_closed');
    const address = await recipientAddress(client, repo, recipient);
    await replacements.withScope(job,address,async()=>{
      await repo.heartbeat(worker);
      if (stopping || !ready) return await repo.finish(worker, job.id, 'failed', 'connection_unavailable_before_send');
      await replacements.begin(job,address);
      const sentIds=[];
      sending = true;
      const water = job.water_prompt && callbackConfig();
      // Keep the full original reminder. The following single-choice poll is its input control.
      let reminder;
      if (water) {
        reminder = await Promise.race([
          client.sendMessage(address, `${whatsappOutbound(job)}\n\nEscolha o volume na enquete abaixo ou responda a esta mensagem com os ml.`, {linkPreview:false,waitUntilMsgSent:true}),
          new Promise((_, reject) => { sendTimer=setTimeout(()=>reject(new Error('send_timeout')),30000); })
        ]);
        clearTimeout(sendTimer);
        if (!serializedId(reminder?.id)) throw new Error('water_binding_failed');
        sentIds.push(serializedId(reminder.id));
        await repo.bindWater(worker,job.id,address,serializedId(reminder.id));
      }
      const message = await Promise.race([
        client.sendMessage(address, water ? new Poll(WATER_QUESTION, WATER_OPTIONS, {allowMultipleAnswers:false}) : whatsappOutbound(job), { linkPreview: false,waitUntilMsgSent:true }),
        new Promise((_, reject) => { sendTimer = setTimeout(() => reject(new Error('send_timeout')), 30000); })
      ]);
      // 'sent' significa aceito pela biblioteca; nao significa lido ou entregue no celular.
      if (!serializedId(message?.id)) throw new Error('send_missing_message_id');
      sentIds.push(serializedId(message.id));
      if(job.event_type==='agent.notice')await agentChannel.bind(job,recipient,address,serializedId(message.id));
      await replacements.complete(job,address,sentIds,water?2:1);
    });
  } catch (error) {
    const code = sending ? sendDiagnostic(error) : ['group_unavailable', 'group_read_only', 'group_lookup_timeout', 'number_not_registered'].includes(error.message) ? error.message : 'lookup_failed';
    console.error(JSON.stringify({event:'whatsapp_send_failed',code}));
    await repo.finish(worker, job.id, sending ? 'uncertain' : 'failed', code);
    if (error.message === 'send_timeout') {
      ready = false;
      setImmediate(() => close('send_timeout').finally(() => process.exit(1)));
    }
  } finally {
    clearTimeout(sendTimer);
  }
}
async function run() {
  while (!stopping && !await repo.lease(worker)) await sleep(10000, undefined, { signal: abort.signal });
  if (stopping) return;
  await repo.state(worker, 'connecting');
  await repo.log(worker, 'worker_started');
  if (await applySessionFingerprint(dataPath, await sessionFingerprint())) await repo.forgetPairedAccount();
  heartbeat = setInterval(async () => {
    if (beating || stopping) return;
    beating = true;
    try { await repo.heartbeat(worker); }
    catch { console.error('worker_lease_lost'); close('lease_lost').finally(() => process.exit(1)); }
    finally { beating = false; }
  }, 15000);
  await resetPairingIfRequested(repo, worker, dataPath);
  // initialize() pode ficar aguardando pareamento. O comando precisa ser observado fora do loop de envios.
  let checkingPairing = false;
  pairingPoll = setInterval(async () => {
    if (stopping || checkingPairing) return;
    checkingPairing = true;
    try {
      if (await repo.pendingPairingReset(worker) || qrRenewalStalled(lastQRAt)) {
        ready = false;
        await close('pairing_reset_requested');
        process.exit(1); // Reinicia o processo. O perfil so e apagado se houver reset pendente ou fingerprint novo.
      }
    } catch { close('pairing_control_failed').finally(() => process.exit(1)); }
    finally { checkingPairing = false; }
  }, 3000);
  client = new Client({ qrMaxRetries: 0, authStrategy: new VolumeAuth({ clientId: SESSION_CLIENT_ID, dataPath }),
    puppeteer: { headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}), args: ['--disable-dev-shm-usage'] } });
  let qrGeneration = 0;
  const safeEvent = action => (...args) => { action(...args).catch(() => close('state_write_failed').finally(() => process.exit(1))); };
  const waterReplies=createWaterReplies({client,repo,worker,replacements});
  const purchases=createWhatsAppPurchases({client,repo,worker,Poll});
  agentChannel=createAgentChannel({client,repo,dataPath});
  const inbound=action => (...args) => { if (!ready || stopping) return; action(...args).catch(()=>console.error('inbound_processing_failed')); };
  client.on('vote_update',inbound(async vote=>{await waterReplies.vote(vote);await purchases.vote(vote);}));
  // message_create includes own-account replies; authorization still requires its recipient registration.
  client.on('message_create',inbound(async message=>{if(await agentChannel.message(message))return;await waterReplies.message(message);await purchases.message(message);}));
  async function noteGroupFailure(error) {
    const code = groupCatalogError(error);
    if (typeof repo.failGroupSync === 'function') await repo.failGroupSync(worker, code);
    await repo.log(worker, 'group_catalog_failed', code);
  }
  client.on('qr', safeEvent(async qr => {
    const version = ++qrGeneration;
    const image = await QRCode.toDataURL(qr, { scale: 8, margin: 4 });
    if (version !== qrGeneration || stopping) return;
    lastQRAt = Date.now();
    await repo.state(worker, 'qr', null, null, encrypt(image, key));
    await repo.log(worker, 'qr_issued');
  }));
  client.on('authenticated', safeEvent(async () => {
    lastQRAt = 0;
    qrGeneration++;
    await repo.state(worker, 'authenticated');
    await repo.log(worker, 'authenticated');
  }));
  let groupsSyncedAt = 0;
  async function syncGroups() {
    try {
      await repo.beginGroupSync(worker);
      await repo.syncGroups(worker, await discoverGroups(client));
    } catch (error) { await noteGroupFailure(error); }
    finally { groupsSyncedAt = Date.now(); }
  }
  client.on('ready', safeEvent(async () => {
    await client.pupPage.evaluate(installSerializedIdCompatibility);
    lastQRAt = 0;
    qrGeneration++;
    const phone = client.info?.wid?.user;
    const accountPhone = phone ? `+${phone}` : null;
    await repo.state(worker, 'connected', client.info?.pushname || 'WhatsApp', accountPhone);
    if (accountPhone && typeof repo.syncFollowSessionPhones === 'function') await repo.syncFollowSessionPhones(accountPhone);
    await repo.markSessionSaved(worker);
    await repo.log(worker, 'connected');
    try{await agentChannel.ready();}catch{console.error('agent_channel_owner_unavailable');}
    ready = true;
  }));
  for (const event of ['auth_failure', 'disconnected']) client.on(event, safeEvent(async reason => {
    if (stopping) return;
    ready = false;
    qrGeneration++;
    const wipe = needsFreshPairing(event, reason);
    try {
      await repo.log(worker, event);
      if (wipe) await repo.requestPairingReset();
    } catch {}
    // destroy() solta o perfil. So depois disso o logout do celular apaga a pasta.
    await close(event);
    if (wipe) await removeSessionArtifacts(dataPath);
    process.exit(1);
  }));
  await client.initialize();
  let cleanedAt = 0;
  let deletionsAt = 0;
  while (!stopping) {
    if (Date.now() - cleanedAt > 3600000) { await repo.cleanup(); try{await agentChannel.cleanup();}catch{console.error('agent_channel_cleanup_failed');} cleanedAt = Date.now(); }
    if (ready) {
      agentChannel.refresh();
      if(Date.now()-deletionsAt>30000) {
        deletionsAt=Date.now();
        try {await replacements.cleanup();} catch {console.error('replacement_cleanup_failed');}
      }
      const job = await repo.claim(worker);
      if (job) {
        activeSend=deliver(job); await activeSend; activeSend=null;
        try {await replacements.cleanup();} catch {console.error('replacement_cleanup_failed');}
        await sleep(2000); continue;
      }
      if (Date.now() - groupsSyncedAt > 60000 || await repo.pendingGroupRefresh(worker)) {
        try { await syncGroups(); } catch (error) { groupsSyncedAt = Date.now(); await noteGroupFailure(error); }
      }
    }
    await sleep(3000, undefined, { signal: abort.signal });
  }
}
run().catch(async error => {
  if (error.name !== 'AbortError') logFailure('worker_start_failed', error);
  await close('worker_failure');
  process.exit(error.name === 'AbortError' ? 0 : 1);
});
