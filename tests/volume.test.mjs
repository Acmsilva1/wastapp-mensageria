import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('volume guarda sessao operacional sem banco e sem historico concluido', async () => {
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
    assert.equal(stored.logs, undefined);
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
    assert.deepEqual(after.deliveries, []);
    assert.deepEqual(after.ingress, []);
    assert.equal(JSON.stringify(after).includes('MENSAGEM-PENDENTE-UNICA'), false);
    assert.equal((await restarted.enqueue(alert())).duplicate, false);
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
