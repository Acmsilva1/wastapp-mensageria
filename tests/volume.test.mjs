import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { VolumeRepository } from '../lib/volume-repository.mjs';
import { openRepository } from '../lib/open-repository.mjs';
import { alertInput, recipientInput } from '../lib/domain.mjs';
import { encrypt } from '../lib/crypto.mjs';
import { createHandler } from '../lib/http-handler.mjs';
import { PAIRING_SESSION_NAMES, needsFreshPairing } from '../worker/pairing-reset.mjs';
import { VolumeAuth, SESSION_CLIENT_ID } from '../worker/volume-auth.mjs';
import { SESSION_CODE_FILES, applySessionFingerprint, buildFingerprint, sessionFingerprint } from '../worker/session-fingerprint.mjs';

const recipient = (overrides = {}) => recipientInput({ name: 'Teste', phone: '+55 (11) 90000-0000', audience: 'perfil-a', events: ['health.water_progress'], ...overrides });
const alert = (overrides = {}) => alertInput({ source: 'superapp', audience: 'perfil-a', event_type: 'health.water_progress', idempotency_key: 'agua:volume', title: 'Teste', message: 'MENSAGEM-PENDENTE-UNICA', ...overrides });

async function tempVolume() {
  return mkdtemp(path.join(tmpdir(), 'mensageria-volume-'));
}

test('fingerprint muda com a versao do worker e nao com o painel', async () => {
  const files = [['worker/index.mjs', 'perfil']];
  assert.equal(buildFingerprint('1.0.0', files), buildFingerprint('1.0.0', files));
  assert.notEqual(buildFingerprint('1.0.0', files), buildFingerprint('1.0.1', files));
  assert.notEqual(buildFingerprint('1.0.0', files), buildFingerprint('1.0.0', [...files, ['worker/volume-auth.mjs', 'auth']]));
  assert.deepEqual(SESSION_CODE_FILES, ['worker/index.mjs', 'worker/pairing-reset.mjs', 'worker/volume-auth.mjs', 'worker/session-fingerprint.mjs']);
  assert.equal(SESSION_CODE_FILES.some(name => name.startsWith('public/') || name.includes('group-target')), false);
  assert.equal(await sessionFingerprint(), await sessionFingerprint());
  assert.equal(PAIRING_SESSION_NAMES.includes(`session-${SESSION_CLIENT_ID}`), true);
});

test('fingerprint novo apaga so o pareamento; o mesmo codigo e a primeira gravacao conservam o perfil', async () => {
  const root = await tempVolume();
  const session = path.join(root, 'session-mensageria');
  try {
    await mkdir(path.join(session, 'Default'), { recursive: true });
    await writeFile(path.join(session, 'Default', 'Cookies'), 'perfil');
    await writeFile(path.join(root, 'RemoteAuth-mensageria.zip'), 'zip-antigo');
    await writeFile(path.join(root, 'mensageria.json'), '{"recipients":[{"id":"1"}]}');
    await writeFile(path.join(root, 'unrelated.txt'), 'preservar');
    const current = 'a'.repeat(64);
    assert.equal(await applySessionFingerprint(root, current), false);
    assert.equal(await readFile(path.join(session, 'Default', 'Cookies'), 'utf8'), 'perfil');
    assert.equal(await applySessionFingerprint(root, current), false);
    assert.equal(await readFile(path.join(session, 'Default', 'Cookies'), 'utf8'), 'perfil');
    assert.equal(await applySessionFingerprint(root, 'b'.repeat(64)), true);
    await assert.rejects(readFile(path.join(session, 'Default', 'Cookies')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, 'RemoteAuth-mensageria.zip')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'mensageria.json'), 'utf8'), '{"recipients":[{"id":"1"}]}');
    assert.equal(await readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'preservar');
    assert.match(await readFile(path.join(root, 'session-fingerprint'), 'utf8'), /b{64}/);
    await assert.rejects(applySessionFingerprint(root, 'curto'), /invalid_session_fingerprint/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('LocalAuth no volume sobrevive a disconnect e destroy; logout remove so o perfil', async () => {
  const root = await tempVolume();
  try {
    const auth = new VolumeAuth({ clientId: SESSION_CLIENT_ID, dataPath: root });
    auth.client = { options: { puppeteer: {} } };
    await auth.beforeBrowserInitialized();
    const marker = path.join(auth.userDataDir, 'Default-marker');
    await writeFile(marker, 'perfil');
    await writeFile(path.join(root, 'mensageria.json'), '{"ok":true}');
    await writeFile(path.join(root, 'session-fingerprint'), 'abc');
    await auth.disconnect();
    await auth.destroy();
    await auth.beforeBrowserInitialized();
    assert.equal(await readFile(marker, 'utf8'), 'perfil');
    auth.userDataDir = root;
    await assert.rejects(auth.logout(), /invalid_session_path/);
    assert.equal(await readFile(path.join(root, 'mensageria.json'), 'utf8'), '{"ok":true}');
    auth.userDataDir = path.join(root, `session-${SESSION_CLIENT_ID}`);
    await auth.logout();
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'mensageria.json'), 'utf8'), '{"ok":true}');
    assert.equal(await readFile(path.join(root, 'session-fingerprint'), 'utf8'), 'abc');
    assert.equal(needsFreshPairing('disconnected', 'LOGOUT'), true);
    assert.equal(needsFreshPairing('auth_failure'), false);
    assert.equal(needsFreshPairing('disconnected', 'TIMEOUT'), false);
    assert.equal(needsFreshPairing('disconnected', 'UNLAUNCHED'), false);
    assert.equal(needsFreshPairing('disconnected', 'CONFLICT'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('volume guarda sessao operacional sem banco e sem o texto da mensagem concluida', async () => {
  const root = await tempVolume();
  try {
    const repo = await openRepository({ WHATSAPP_DATA_PATH: root });
    assert.equal(repo.constructor.name, 'VolumeRepository');
    const worker = randomUUID();
    assert.equal(await repo.lease(worker), true);
    assert.equal(await repo.lease(randomUUID()), false);
    await repo.saveRecipient(recipient());
    const queued = await repo.enqueue(alert());
    assert.equal(queued.jobs.length, 1);
    assert.equal((await repo.enqueue(alert())).duplicate, true);
    await assert.rejects(repo.enqueue(alert({ message: 'outro' })), /idempotency_conflict/);
    const stored = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(stored.deliveries.length, 1);
    assert.deepEqual(stored.logs, []);
    assert.match(JSON.stringify(stored), /MENSAGEM-PENDENTE-UNICA/);
    const session = path.join(root, 'session-mensageria');
    await mkdir(session, { recursive: true });
    await writeFile(path.join(session, 'Cookies'), 'perfil');
    const restarted = await VolumeRepository.open(root);
    assert.equal((await restarted.recipients()).length, 1);
    assert.equal(await readFile(path.join(session, 'Cookies'), 'utf8'), 'perfil');
    const job = await restarted.claim(worker);
    assert.equal(job.message, 'MENSAGEM-PENDENTE-UNICA');
    await restarted.finish(worker, job.id, 'sent', null, 'wamid');
    const after = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(after.ingress.length, 1);
    assert.equal(after.ingress[0].idempotency_key, 'agua:volume');
    assert.equal(after.deliveries.length, 1);
    assert.equal(after.deliveries[0].status, 'sent');
    assert.equal(after.deliveries[0].title, null);
    assert.equal(after.deliveries[0].message, null);
    assert.equal(after.deliveries[0].whatsapp_id, 'wamid');
    assert.equal(JSON.stringify(after).includes('MENSAGEM-PENDENTE-UNICA'), false);
    const replay = await restarted.enqueue(alert());
    assert.equal(replay.duplicate, true);
    assert.equal(replay.jobs.length, 1);
    assert.equal(replay.jobs[0].status, 'sent');
    await assert.rejects(restarted.enqueue(alert({ message: 'outro' })), /idempotency_conflict/);
    const still = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(still.deliveries.length, 1);
    assert.equal(still.ingress.length, 1);
    const image = 'data:image/png;base64,ZmFrZQ==';
    const key = Buffer.from('c'.repeat(64), 'hex');
    await restarted.state(worker, 'qr', null, null, encrypt(image, key));
    assert.equal(JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8')).state.qr_encrypted.includes('data:image'), false);
    await restarted.state(worker, 'connected', 'Casa', '+5511900000000');
    const connected = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(connected.state.qr_encrypted, null);
    assert.equal(connected.state.account_phone, '+5511900000000');
    assert.equal(connected.state.status, 'connected');
    await restarted.forgetPairedAccount();
    const forgotten = await restarted.snapshot();
    assert.equal(forgotten.state.account_phone, null);
    assert.equal(forgotten.logs.length, 0);
    assert.equal(await readFile(path.join(session, 'Cookies'), 'utf8'), 'perfil');
    assert.equal((await restarted.allowLogin('global')), true);
    for (let i = 0; i < 9; i++) await restarted.allowLogin('global');
    assert.equal(await restarted.allowLogin('global'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('envio interrompido ou vencido nao libera a mesma chave', async () => {
  const root = await tempVolume();
  try {
    const repo = await VolumeRepository.open(root);
    const owner = randomUUID();
    const other = randomUUID();
    const saved = await repo.saveRecipient(recipient());
    assert.equal(await repo.lease(owner), true);
    await repo.enqueue(alert({ idempotency_key: 'agua:incerto', message: 'TEXTO-ENVIO' }));
    const job = await repo.claim(owner);
    assert.equal(job.message, 'TEXTO-ENVIO');
    await repo.release(owner);
    assert.equal(await repo.lease(other), true);
    assert.equal(await repo.claim(other), null);
    const interrupted = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(interrupted.deliveries.length, 1);
    assert.equal(interrupted.deliveries[0].status, 'uncertain');
    assert.equal(interrupted.deliveries[0].title, null);
    assert.equal(interrupted.deliveries[0].message, null);
    assert.ok(interrupted.deliveries[0].finished_at);
    assert.equal(interrupted.ingress.length, 1);
    assert.equal(JSON.stringify(interrupted).includes('TEXTO-ENVIO'), false);
    assert.equal((await repo.enqueue(alert({ idempotency_key: 'agua:incerto', message: 'TEXTO-ENVIO' }))).duplicate, true);
    await assert.rejects(repo.enqueue(alert({ idempotency_key: 'agua:incerto', message: 'outro texto' })), /idempotency_conflict/);

    await repo.enqueue(alert({ idempotency_key: 'agua:velha', message: 'TEXTO-VELHO' }));
    const file = path.join(root, 'mensageria.json');
    const queued = JSON.parse(await readFile(file, 'utf8'));
    const pending = queued.deliveries.find(item => item.idempotency_key === 'agua:velha');
    pending.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(file, JSON.stringify(queued));
    await repo.cleanup();
    const expired = JSON.parse(await readFile(file, 'utf8'));
    const oldJob = expired.deliveries.find(item => item.idempotency_key === 'agua:velha');
    assert.equal(oldJob.status, 'cancelled');
    assert.equal(oldJob.message, null);
    assert.equal(expired.ingress.some(item => item.idempotency_key === 'agua:velha'), true);
    assert.equal((await repo.enqueue(alert({ idempotency_key: 'agua:velha', message: 'TEXTO-VELHO' }))).duplicate, true);

    await repo.enqueue(alert({ idempotency_key: 'agua:off', message: 'TEXTO-OFF' }));
    await repo.toggleRecipient(saved.id, false);
    assert.equal(await repo.claim(other), null);
    const disabled = JSON.parse(await readFile(file, 'utf8'));
    const off = disabled.deliveries.find(item => item.idempotency_key === 'agua:off');
    assert.equal(off.status, 'cancelled');
    assert.equal(off.message, null);
    assert.equal(disabled.ingress.some(item => item.idempotency_key === 'agua:off'), true);
    assert.equal((await repo.enqueue(alert({ idempotency_key: 'agua:off', message: 'TEXTO-OFF' }))).duplicate, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('financeiro faz fan-out por flag; agua e dieta so para o perfil da Ref', async () => {
  const root = await tempVolume();
  try {
    const repo = await VolumeRepository.open(root);
    const worker = randomUUID();
    const groupId = '120363123456789@g.us';
    assert.equal(await repo.lease(worker), true);
    await repo.state(worker, 'connected');
    await repo.syncGroups(worker, [{ id: groupId, name: 'Grupo' }]);
    const phone1 = await repo.saveRecipient(recipient({ phone: '+5511900000001', audience: '1', events: ['financeiro.daily_summary', 'health.water_progress', 'health.diet_menu'] }));
    const phone2 = await repo.saveRecipient(recipient({ phone: '+5521900000002', audience: '2', events: ['financeiro.daily_summary', 'health.water_progress', 'health.diet_menu'] }));
    const phoneOff = await repo.saveRecipient(recipient({ phone: '+5531900000003', audience: '2', events: ['health.water_progress', 'health.diet_menu'] }));
    const disabled = await repo.saveRecipient(recipient({ phone: '+5541900000004', audience: '2', events: ['financeiro.daily_summary'], enabled: false }));
    const group2 = await repo.saveRecipient(recipientInput({ target_type: 'group', group_id: groupId, name: 'Grupo 2', audience: '2', events: ['financeiro.daily_summary', 'health.water_progress'] }));
    const money = await repo.enqueue(alert({ audience: '1', event_type: 'financeiro.daily_summary', idempotency_key: 'fin:1', title: 'Resumo', message: 'Caixa do dia' }));
    assert.equal(money.jobs.length, 3);
    const stored = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    const financeIds = stored.deliveries.filter(item => item.idempotency_key === 'fin:1').map(item => item.recipient_id).sort();
    assert.deepEqual(financeIds, [phone1.id, phone2.id, group2.id].sort());
    assert.equal(financeIds.includes(phoneOff.id), false);
    assert.equal(financeIds.includes(disabled.id), false);
    const water = await repo.enqueue(alert({ audience: '1', event_type: 'health.water_progress', idempotency_key: 'agua:1' }));
    assert.equal(water.jobs.length, 1);
    const afterWater = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.deepEqual(afterWater.deliveries.filter(item => item.idempotency_key === 'agua:1').map(item => item.recipient_id), [phone1.id]);
    const diet = await repo.enqueue(alert({ audience: '1', event_type: 'health.diet_menu', idempotency_key: 'dieta:1', title: 'Almoco', message: 'Menu do dia' }));
    assert.equal(diet.jobs.length, 1);
    const diet2 = await repo.enqueue(alert({ audience: '2', event_type: 'health.diet_menu', idempotency_key: 'dieta:2', title: 'Jantar', message: 'Menu dela' }));
    assert.equal(diet2.jobs.length, 2);
    const afterDiet = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.deepEqual(afterDiet.deliveries.filter(item => item.idempotency_key === 'dieta:1').map(item => item.recipient_id), [phone1.id]);
    assert.deepEqual(afterDiet.deliveries.filter(item => item.idempotency_key === 'dieta:2').map(item => item.recipient_id).sort(), [phone2.id, phoneOff.id].sort());
    const claimed = [];
    for (;;) {
      const job = await repo.claim(worker);
      if (!job) break;
      claimed.push(`${job.recipient_id}:${job.event_type}:${job.idempotency_key}`);
      await repo.finish(worker, job.id, 'sent');
    }
    const of = (event, key) => claimed.filter(item => item.includes(`:${event}:${key}`)).map(item => item.slice(0, item.indexOf(':'))).sort();
    assert.deepEqual(of('financeiro.daily_summary', 'fin:1'), [phone1.id, phone2.id, group2.id].sort());
    assert.deepEqual(of('health.water_progress', 'agua:1'), [phone1.id]);
    assert.deepEqual(of('health.diet_menu', 'dieta:1'), [phone1.id]);
    assert.deepEqual(of('health.diet_menu', 'dieta:2'), [phone2.id, phoneOff.id].sort());
    const after = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.equal(after.deliveries.some(item => item.status === 'cancelled'), false);
    assert.equal(after.ingress.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock do volume so sai com o token deste processo', async () => {
  const root = await tempVolume();
  try {
    const repo = await VolumeRepository.open(root);
    const lock = path.join(root, '.lock');
    await repo.mutate(async () => {
      await writeFile(lock, 'token-de-outro-processo');
    });
    assert.equal(await readFile(lock, 'utf8'), 'token-de-outro-processo');
    await rm(lock, { force: true });

    const fresh = `${Date.now()}:${process.pid}:${randomUUID()}`;
    await writeFile(lock, fresh);
    const stale = new Date(Date.now() - 20000);
    await utimes(lock, stale, stale);
    await assert.rejects(repo.read(), /volume_lock_timeout/);
    assert.equal(await readFile(lock, 'utf8'), fresh);

    const oldToken = `${Date.now() - 20000}:${process.pid}:${randomUUID()}`;
    await writeFile(lock, oldToken);
    await utimes(lock, stale, stale);
    await repo.read();
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('teste manual enfileira um unico envio para o destinatario escolhido', async () => {
  const root = await tempVolume();
  const repo = await VolumeRepository.open(root);
  const env = { ADMIN_TOKEN: 'a'.repeat(64), INTEGRATION_TOKEN: 'b'.repeat(64), SESSION_ENCRYPTION_KEY: 'c'.repeat(64), APP_ORIGIN: 'http://127.0.0.1:9' };
  const server = http.createServer(createHandler({ repository: repo, env }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/control?action=`;
  const headers = { 'Content-Type': 'application/json', 'X-Panel-Request': '1', Origin: env.APP_ORIGIN };
  try {
    const andre = await repo.saveRecipient(recipient({ name: 'Andre', phone: '+55 27 98851-6301', audience: 'andre', events: ['health.diet_menu', 'financeiro.daily_summary'] }));
    const juliana = await repo.saveRecipient(recipient({ name: 'Juliana', phone: '+55 27 99501-5990', audience: 'juliana', events: ['health.diet_menu'] }));
    const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ token: env.ADMIN_TOKEN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const auth = { ...headers, Cookie: cookie };
    const queued = await fetch(base + 'recipient-test', { method: 'POST', headers: auth, body: JSON.stringify({ id: andre.id }) });
    assert.equal(queued.status, 202);
    const body = await queued.json();
    assert.equal(body.ok, true);
    assert.equal(body.job.recipient_id, andre.id);
    assert.equal(body.job.event_type, 'health.diet_menu');
    const data = await repo.read();
    assert.equal(data.deliveries.length, 1);
    assert.equal(data.deliveries[0].recipient_id, andre.id);
    assert.equal(data.deliveries[0].recipient_id === juliana.id, false);
    assert.match(data.deliveries[0].idempotency_key, /^panel-test:/);
    const limited = await fetch(base + 'recipient-test', { method: 'POST', headers: auth, body: JSON.stringify({ id: andre.id }) });
    assert.equal(limited.status, 429);
    await repo.mutate(d => {
      d.recipients.push({
        id: randomUUID(), name: 'Sessao', phone: '+5527999058023', target_type: 'phone', group_id: null,
        audience: 'sessao-wa', events: ['agent.notice'], permissions: [], follow_session: true, enabled: true,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
    });
    const sessionId = (await repo.read()).recipients.find(r => r.follow_session).id;
    const blocked = await fetch(base + 'recipient-test', { method: 'POST', headers: auth, body: JSON.stringify({ id: sessionId }) });
    assert.equal(blocked.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('volume persiste connection logs com retencao e snapshot recente', async () => {
  const root = await tempVolume();
  try {
    const repo = await VolumeRepository.open(root);
    const worker = randomUUID();
    assert.equal(await repo.lease(worker), true);
    await repo.log(worker, 'worker_started');
    await repo.log(worker, 'qr_issued');
    await repo.log(worker, 'authenticated');
    await repo.log(worker, 'connected');
    await repo.markSessionSaved(worker);
    await repo.log(worker, 'group_catalog_failed', 'group_lookup_timeout');
    const request = await repo.requestPairingReset();
    await repo.completePairingReset(worker, request);
    const snap = await repo.snapshot();
    assert.equal(snap.logs[0].event, 'pairing_reset_completed');
    assert.equal(snap.logs.find(row => row.event === 'group_catalog_failed')?.code, 'group_lookup_timeout');
    assert.ok(snap.logs.some(row => row.event === 'session_saved'));
    assert.ok(snap.logs.every(row => typeof row.created_at === 'string'));
    assert.deepEqual(snap.logs.map(row => row.event).slice(0, 4), ['pairing_reset_completed', 'group_catalog_failed', 'session_saved', 'connected']);
    const persisted = JSON.parse(await readFile(path.join(root, 'mensageria.json'), 'utf8'));
    assert.ok(Array.isArray(persisted.logs));
    assert.ok(persisted.logs.length >= 6);
    for (let i = 0; i < 120; i++) await repo.log(worker, `event_${String(i).padStart(3, '0')}`);
    const capped = await repo.read();
    assert.equal(capped.logs.length, 100);
    assert.equal((await repo.snapshot()).logs.length, 30);
    assert.equal((await repo.snapshot()).logs[0].event, 'event_119');
    await repo.mutate(data => {
      data.logs = [
        { event: 'ancient', code: null, created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() },
        { event: 'recent', code: null, created_at: new Date().toISOString() }
      ];
    });
    await repo.cleanup();
    const pruned = await repo.read();
    assert.deepEqual(pruned.logs.map(row => row.event), ['recent']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('painel local le o volume sem DATABASE_URL e o QR nao fica depois de conectar', async () => {
  const root = await tempVolume();
  const repo = await VolumeRepository.open(root);
  const env = { ADMIN_TOKEN: 'a'.repeat(64), INTEGRATION_TOKEN: 'b'.repeat(64), SESSION_ENCRYPTION_KEY: 'c'.repeat(64), APP_ORIGIN: 'http://127.0.0.1:9' };
  const server = http.createServer(createHandler({ repository: repo, env }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/control?action=`;
  const headers = { 'Content-Type': 'application/json', 'X-Panel-Request': '1', Origin: env.APP_ORIGIN };
  try {
    const worker = randomUUID();
    await repo.lease(worker);
    await repo.state(worker, 'qr', null, null, encrypt('data:image/png;base64,ZmFrZQ==', Buffer.from(env.SESSION_ENCRYPTION_KEY, 'hex')));
    const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ token: env.ADMIN_TOKEN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const before = await (await fetch(base + 'snapshot', { headers: { Cookie: cookie } })).json();
    assert.equal(before.state.qr, 'data:image/png;base64,ZmFrZQ==');
    assert.deepEqual(before.logs, []);
    await repo.state(worker, 'connected', 'Casa', '+5511900000000');
    await repo.markSessionSaved(worker);
    const after = await (await fetch(base + 'snapshot', { headers: { Cookie: cookie } })).json();
    assert.equal(after.state.qr, null);
    assert.equal(after.state.account_phone, '+5511900000000');
    assert.ok(after.state.session_saved_at);
    const accepted = await fetch(base + 'event', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${env.INTEGRATION_TOKEN}` }, body: JSON.stringify(alert({ idempotency_key: 'painel' })) });
    assert.equal(accepted.status, 422);
    await repo.saveRecipient(recipient());
    const queued = await fetch(base + 'event', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${env.INTEGRATION_TOKEN}` }, body: JSON.stringify(alert({ idempotency_key: 'painel' })) });
    assert.equal(queued.status, 202);
    assert.equal((await repo.requestPairingReset()) === (await repo.requestPairingReset()), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('worker e Dockerfile conservam o volume fora de logout e de versao nova', async () => {
  const worker = await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  const docker = await readFile(new URL('../Dockerfile.whatsapp', import.meta.url), 'utf8');
  assert.match(worker, /new VolumeAuth\(/);
  assert.match(worker, /applySessionFingerprint/);
  assert.match(worker, /if \(wipe\) await removeSessionArtifacts\(dataPath\)/);
  assert.match(worker, /needsFreshPairing\(event, reason\)/);
  assert.doesNotMatch(worker, /RemoteAuth/);
  assert.doesNotMatch(worker, /client\.logout\(/);
  assert.match(worker, /process\.on\('SIGTERM', \(\) => close\(\)\.then\(\(\) => process\.exit\(0\)\)\)/);
  assert.match(docker, /VOLUME \["\/app\/\.runtime\/whatsapp"\]/);
  assert.doesNotMatch(docker, /rm\s+-rf[^\n]*\.runtime\/whatsapp/);
});
