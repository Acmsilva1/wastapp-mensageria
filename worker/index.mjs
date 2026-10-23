import { logFailure } from '../lib/diagnostics.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import QRCode from 'qrcode';
import { database } from '../lib/db.mjs';
import { Repository } from '../lib/repository.mjs';
import { encryptionKey, encrypt } from '../lib/crypto.mjs';
import { EncryptedStore } from './remote-store.mjs';
const require = createRequire(import.meta.url);
const { Client, RemoteAuth } = require('whatsapp-web.js');

const worker = randomUUID();
const pool = database();
const repo = new Repository(pool);
const key = encryptionKey();
const dataPath = path.resolve(process.env.WHATSAPP_DATA_PATH || '.runtime/whatsapp');
await mkdir(dataPath, { recursive: true, mode: 0o700 });
let client;
let ready = false;
let stopping = false;
let heartbeat;
let beating = false;
let activeSend;
let closing;
const abort = new AbortController();

async function close(reason = 'stopped') {
  if (closing) return closing;
  stopping = true;
  ready = false;
  abort.abort();
  closing = (async () => {
    if (activeSend) await Promise.race([activeSend.catch(() => {}), sleep(20000)]);
    try { await client?.destroy(); } catch {}
    clearInterval(heartbeat);
    try {
      await repo.state(worker, 'offline');
      await repo.log(worker, 'worker_stopped', reason);
      await repo.query('update mensageria.connection_state set lease_until=now() where id=1 and worker_id=$1', [worker]);
    } catch {}
    await pool.end();
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
    const recipient = (await repo.query('select enabled,events,audience from mensageria.recipients where id=$1', [job.recipient_id])).rows[0];
    if (!recipient?.enabled || recipient.audience !== job.audience || !recipient.events.includes(job.event_type)) return await repo.finish(worker, job.id, 'cancelled', 'recipient_disabled');
    const number = await client.getNumberId(job.phone.slice(1));
    if (!number) return await repo.finish(worker, job.id, 'failed', 'number_not_registered');
    await repo.heartbeat(worker);
    if (stopping || !ready) return await repo.finish(worker, job.id, 'failed', 'connection_unavailable_before_send');
    sending = true;
    const message = await Promise.race([
      client.sendMessage(number._serialized, `${job.title}\n\n${job.message}`, { linkPreview: false }),
      new Promise((_, reject) => { sendTimer = setTimeout(() => reject(new Error('send_timeout')), 30000); })
    ]);
    // 'sent' significa aceito pela biblioteca; nao significa lido ou entregue no celular.
    await repo.finish(worker, job.id, 'sent', null, message.id?._serialized || null);
  } catch (error) {
    await repo.finish(worker, job.id, sending ? 'uncertain' : 'failed', sending ? 'send_unconfirmed' : 'lookup_failed');
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
  heartbeat = setInterval(async () => {
    if (beating || stopping) return;
    beating = true;
    try { await repo.heartbeat(worker); }
    catch { console.error('worker_lease_lost'); close('lease_lost').finally(() => process.exit(1)); }
    finally { beating = false; }
  }, 15000);
  const store = new EncryptedStore(repo, key, dataPath, worker);
  client = new Client({ authStrategy: new RemoteAuth({ store, clientId: 'mensageria', dataPath, backupSyncIntervalMs: 300000 }),
    puppeteer: { headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}), args: ['--disable-dev-shm-usage'] } });
  let qrGeneration = 0;
  const safeEvent = action => (...args) => { action(...args).catch(() => close('state_write_failed').finally(() => process.exit(1))); };
  client.on('qr', safeEvent(async qr => {
    const version = ++qrGeneration;
    const image = await QRCode.toDataURL(qr, { scale: 8, margin: 4 });
    if (version !== qrGeneration || stopping) return;
    await repo.state(worker, 'qr', null, null, encrypt(image, key));
    await repo.log(worker, 'qr_issued');
  }));
  client.on('authenticated', safeEvent(async () => {
    qrGeneration++;
    await repo.state(worker, 'authenticated');
    await repo.log(worker, 'authenticated');
  }));
  client.on('ready', safeEvent(async () => {
    qrGeneration++;
    const phone = client.info?.wid?.user;
    await repo.state(worker, 'connected', client.info?.pushname || 'WhatsApp', phone ? `+${phone}` : null);
    await repo.log(worker, 'connected');
    ready = true;
  }));
  client.on('remote_session_saved', safeEvent(async () => { await repo.log(worker, 'session_saved'); }));
  for (const event of ['auth_failure', 'disconnected']) client.on(event, safeEvent(async () => {
    ready = false;
    qrGeneration++;
    await repo.log(worker, event);
    await close(event);
    process.exit(1);
  }));
  await client.initialize();
  let cleanedAt = 0;
  while (!stopping) {
    if (Date.now() - cleanedAt > 3600000) { await repo.cleanup(); cleanedAt = Date.now(); }
    if (ready) {
      const job = await repo.claim(worker);
      if (job) { activeSend = deliver(job); await activeSend; activeSend = null; await sleep(2000); continue; }
    }
    await sleep(3000, undefined, { signal: abort.signal });
  }
}
run().catch(async error => {
  if (error.name !== 'AbortError') logFailure('worker_start_failed', error);
  await close('worker_failure');
  process.exit(error.name === 'AbortError' ? 0 : 1);
});
