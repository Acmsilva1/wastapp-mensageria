import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../lib/repository.mjs';
import { alertInput, recipientInput } from '../lib/domain.mjs';
import { encrypt, decrypt, makeSession, validSession } from '../lib/crypto.mjs';
import { createHandler } from '../lib/http-handler.mjs';
import { EncryptedStore } from '../worker/remote-store.mjs';
import { resetPairingIfRequested, needsFreshPairing, qrRenewalStalled } from '../worker/pairing-reset.mjs';

let db, repo;
const up = await readFile(new URL('../migrations/001_mensageria.sql', import.meta.url), 'utf8');
const down = await readFile(new URL('../migrations/001_rollback.sql', import.meta.url), 'utf8');
before(async () => {
  db = new PGlite();
  await db.exec(up);
  await db.exec(await readFile(new URL('../migrations/002_pairing_reset.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/003_group_recipients.sql', import.meta.url), 'utf8'));
  repo = new Repository({ query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) });
});
after(async () => { await db.close(); });
async function reset() {
  await db.exec('truncate mensageria.deliveries,mensageria.ingress,mensageria.recipients,mensageria.session_backups,mensageria.connection_logs,mensageria.login_limits; update mensageria.connection_state set worker_id=null,lease_until=null,status=\'offline\',qr_encrypted=null,qr_expires_at=null,account_phone=null,session_saved_at=null,pairing_request_id=null,pairing_completed_id=null;');
}
const recipient = (overrides = {}) => recipientInput({ name: 'Teste', phone: '+55 (11) 90000-0000', audience: 'perfil-a', events: ['health.water_progress'], ...overrides });
const alert = (overrides = {}) => alertInput({ source: 'superapp', audience: 'perfil-a', event_type: 'health.water_progress', idempotency_key: 'agua:2026-10-23:10:perfil-a', title: 'Teste', message: 'Mensagem de teste sem envio real.', ...overrides });

test('validacao exige DDI, perfil e tipo de alerta conhecido', () => {
  assert.equal(recipient().phone, '+5511900000000');
  assert.throws(() => recipient({ phone: '11900000000' }), /phone_requires_country_code/);
  assert.throws(() => recipient({ events: ['qualquer-coisa'] }), /invalid_input/);
  assert.throws(() => alert({ audience: '' }), /invalid_input/);
  assert.throws(() => recipientInput(null), /invalid_input/);
});
test('AES autentica o backup e cookies expiram sem aceitar adulteracao', () => {
  const key = randomBytes(32), encrypted = encrypt('credencial-ficticia', key);
  assert.equal(decrypt(encrypted, key).toString(), 'credencial-ficticia');
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decrypt(encrypted, key));
  const cookie = makeSession('secret', 1000);
  assert.equal(validSession(cookie, 'secret', 1001), true);
  assert.equal(validSession(cookie, 'wrong', 1001), false);
  assert.equal(validSession(cookie, 'secret', 1000 + 8 * 3600000), false);
});
test('fila separa perfis, tipos e destinatarios desativados', async () => {
  await reset();
  const accepted = await repo.saveRecipient(recipient());
  await repo.saveRecipient(recipient({ phone: '+5521900000000', audience: 'perfil-b' }));
  await repo.saveRecipient(recipient({ phone: '+5531900000000', events: ['health.diet_menu'] }));
  await repo.saveRecipient(recipient({ phone: '+5541900000000', enabled: false }));
  const result = await repo.enqueue(alert());
  assert.equal(result.jobs.length, 1);
  const row = (await db.query('select recipient_id from mensageria.deliveries')).rows[0];
  assert.equal(row.recipient_id, accepted.id);
  await assert.rejects(repo.enqueue(alert({ audience: 'sem-perfil', idempotency_key: 'outro' })), /no_authorized_recipients/);
});
test('repeticao da chave nao duplica envio; mudanca de conteudo retorna conflito', async () => {
  await reset(); await repo.saveRecipient(recipient());
  const first = await repo.enqueue(alert());
  const second = await repo.enqueue(alert());
  assert.equal(second.duplicate, true); assert.deepEqual(first.jobs, second.jobs);
  await assert.rejects(repo.enqueue(alert({ message: 'Outro conteudo' })), /idempotency_conflict/);
});
test('lease impede dois workers; interrupcao vira incerto sem reenviar', async () => {
  await reset(); await repo.saveRecipient(recipient()); await repo.enqueue(alert());
  const one = randomUUID(), two = randomUUID();
  assert.equal(await repo.lease(one), true); assert.equal(await repo.lease(two), false);
  await assert.rejects(repo.claim(two), /worker_lease_lost/);
  const claimed = await repo.claim(one); assert.ok(claimed);
  await db.exec("update mensageria.connection_state set lease_until=now()-interval '1 second'");
  assert.equal(await repo.lease(two), true); assert.equal(await repo.claim(two), null);
  assert.equal((await db.query('select status,message from mensageria.deliveries')).rows[0].status, 'uncertain');
  assert.equal((await db.query('select message from mensageria.deliveries')).rows[0].message, null);
});
test('desativar destinatario cancela pendencias antes do envio', async () => {
  await reset(); const r = await repo.saveRecipient(recipient()); await repo.enqueue(alert());
  await repo.toggleRecipient(r.id, false); const worker = randomUUID(); await repo.lease(worker);
  assert.equal(await repo.claim(worker), null);
  assert.equal((await db.query('select status from mensageria.deliveries')).rows[0].status, 'cancelled');
});
test('RemoteAuth armazena arquivo criptografado e recupera sem mudar bytes', async () => {
  await reset(); const worker = randomUUID(); await repo.lease(worker);
  const key = randomBytes(32), folder = await mkdtemp(path.join(tmpdir(), 'mensageria-test-'));
  try {
    const store = new EncryptedStore(repo, key, folder, worker);
    await writeFile(path.join(folder, 'RemoteAuth-test.zip'), 'arquivo-ficticio');
    await store.save({ session: 'RemoteAuth-test' });
    assert.equal(await store.sessionExists({ session: 'RemoteAuth-test' }), true);
    const archive = (await db.query('select encrypted_archive from mensageria.session_backups')).rows[0].encrypted_archive;
    assert.equal(Buffer.from(archive).includes(Buffer.from('arquivo-ficticio')), false);
    const output = path.join(folder, 'restored.zip'); await store.extract({ session: 'RemoteAuth-test', path: output });
    assert.equal(await readFile(output, 'utf8'), 'arquivo-ficticio');
    await store.delete({ session: 'RemoteAuth-test' }); assert.equal(await store.sessionExists({ session: 'RemoteAuth-test' }), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('API exige login, origem correta e token distinto para enfileirar', async () => {
  await reset(); await repo.saveRecipient(recipient());
  const env = { ADMIN_TOKEN: 'a'.repeat(64), INTEGRATION_TOKEN: 'b'.repeat(64), SESSION_ENCRYPTION_KEY: 'c'.repeat(64), APP_ORIGIN: 'https://painel.example' };
  const server = http.createServer(createHandler({ repository: repo, env }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/control?action=`;
  const headers = { 'Content-Type': 'application/json', 'X-Panel-Request': '1', Origin: env.APP_ORIGIN };
  try {
    assert.equal((await fetch(base + 'snapshot')).status, 401);
    assert.equal((await fetch(base + 'login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ token: env.ADMIN_TOKEN }) })).status, 403);
    const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ token: env.ADMIN_TOKEN }) });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert.match(login.headers.get('set-cookie'), /Secure/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const snapshot = await (await fetch(base + 'snapshot', { headers: { Cookie: cookie } })).json();
    assert.equal(snapshot.recipients.length, 1); assert.equal(snapshot.state.qr_encrypted, undefined); assert.equal(snapshot.state.worker_id, undefined);
    assert.equal((await fetch(base + 'event', { method: 'POST', headers, body: JSON.stringify(alert()) })).status, 401);
    const accepted = await fetch(base + 'event', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${env.INTEGRATION_TOKEN}` }, body: JSON.stringify(alert()) });
    assert.equal(accepted.status, 202); assert.equal((await accepted.json()).jobs.length, 1);
    const invalid = await fetch(base + 'recipients', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: 'null' });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('retencao remove corpo pendente expirado sem entregar e limpa logs antigos', async () => {
  await reset(); await repo.saveRecipient(recipient()); await repo.enqueue(alert());
  await db.exec("update mensageria.deliveries set created_at=now()-interval '2 days'; insert into mensageria.connection_logs(event,created_at) values('old',now()-interval '31 days')");
  await repo.cleanup();
  const row = (await db.query('select status,message from mensageria.deliveries')).rows[0];
  assert.equal(row.status, 'cancelled'); assert.equal(row.message, null);
  assert.equal((await db.query('select * from mensageria.connection_logs')).rows.length, 0);
});

test('novo pareamento exige sessao administrativa e confirmacao; integracao nao controla conta', async () => {
  await reset();
  const env = { ADMIN_TOKEN: 'a'.repeat(64), INTEGRATION_TOKEN: 'b'.repeat(64), SESSION_ENCRYPTION_KEY: 'c'.repeat(64), APP_ORIGIN: 'https://painel.example' };
  const server = http.createServer(createHandler({ repository: repo, env }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/control?action=';
  const headers = { 'Content-Type': 'application/json', 'X-Panel-Request': '1', Origin: env.APP_ORIGIN };
  const post = (extra, body = { confirm: 'reset_pairing' }) => fetch(base+'pairing-reset', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ Authorization: 'Bearer '+env.INTEGRATION_TOKEN })).status, 401);
    const Cookie = 'wm_session='+makeSession(env.ADMIN_TOKEN);
    assert.equal((await post({Cookie, Origin:'https://evil.example'})).status, 403);
    assert.equal((await post({Cookie}, {})).status, 400);
    const worker = randomUUID(); await repo.lease(worker);
    await repo.state(worker, 'qr', null, null, encrypt('data:image/png;base64,ZmFrZQ==', Buffer.from(env.SESSION_ENCRYPTION_KEY, 'hex')));
    const beforeReset = await (await fetch(base+'snapshot', {headers:{Cookie}})).json();
    assert.equal(beforeReset.state.qr, 'data:image/png;base64,ZmFrZQ==');
    assert.equal((await post({Cookie})).status, 202);
    const state = await (await fetch(base+'snapshot', {headers:{Cookie}})).json();
    assert.equal(state.state.pairing_pending, true);
    assert.equal(state.state.status, 'restarting');
    assert.equal(state.state.qr, null);
    assert.equal(state.state.pairing_request_id, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reset e idempotente, restrito ao lease e mantem destinatarios, fila e logs', async () => {
  await reset(); await repo.saveRecipient(recipient()); await repo.enqueue(alert());
  const worker = randomUUID(); await repo.lease(worker);
  await db.query("insert into mensageria.session_backups(name,encrypted_archive) values('RemoteAuth-mensageria',$1),('other-session',$1)", [Buffer.from('backup-ficticio')]);
  await repo.log(worker, 'connected');
  const request = await repo.requestPairingReset();
  assert.equal(await repo.requestPairingReset(), request);
  await assert.rejects(repo.completePairingReset(randomUUID(),request), /worker_lease_lost/);
  const root = await mkdtemp(path.join(tmpdir(), 'pairing-reset-test-'));
  try {
    await writeFile(path.join(root,'unrelated.txt'),'preservar');
    await writeFile(path.join(root,'RemoteAuth-mensageria.zip'),'backup');
    assert.equal(await resetPairingIfRequested(repo,worker,root),true);
    assert.equal(await resetPairingIfRequested(repo,worker,root),false);
    assert.equal(await readFile(path.join(root,'unrelated.txt'),'utf8'),'preservar');
    await assert.rejects(readFile(path.join(root,'RemoteAuth-mensageria.zip')), {code:'ENOENT'});
    assert.equal((await repo.recipients()).length,1);
    assert.equal((await db.query('select * from mensageria.deliveries')).rows.length,1);
    assert.equal((await db.query('select * from mensageria.session_backups')).rows[0].name,'other-session');
    assert.equal((await db.query("select * from mensageria.connection_logs where event='connected'")).rows.length,1);
    assert.equal((await db.query("select * from mensageria.connection_logs where event='pairing_reset_completed'")).rows.length,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('falha ao limpar sessao mantem pedido pendente para proxima inicializacao', async () => {
  await reset(); const worker = randomUUID(); await repo.lease(worker); const request = await repo.requestPairingReset();
  await assert.rejects(resetPairingIfRequested(repo,worker,tmpdir(), async () => {throw new Error('locked');}), /locked/);
  assert.equal(await repo.pendingPairingReset(worker),request);
  assert.equal(needsFreshPairing('disconnected','LOGOUT'),true);
  assert.equal(needsFreshPairing('auth_failure'),true);
  assert.equal(needsFreshPairing('disconnected','TIMEOUT'),false);
  assert.equal(qrRenewalStalled(1000, 91001), true);
  assert.equal(qrRenewalStalled(1000, 90000), false);
  assert.equal(qrRenewalStalled(0, 99999999), false); // autenticado/conectado nao reinicia
});

test('migration e rollback funcionam e RLS esta habilitada em todas as tabelas', async () => {
  const rows = (await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='mensageria' and relkind='r'")).rows;
  assert.equal(rows.length, 8); assert.ok(rows.every(r => r.relrowsecurity));
  const resetUp = await readFile(new URL('../migrations/002_pairing_reset.sql', import.meta.url), 'utf8');
  await db.exec(resetUp); // repeticao segura em banco ja atualizado
  await db.exec(await readFile(new URL('../migrations/002_pairing_reset_rollback.sql', import.meta.url), 'utf8'));
  await db.exec(resetUp);
  await db.exec(await readFile(new URL('../migrations/003_group_recipients_rollback.sql', import.meta.url), 'utf8'));
  await db.exec(down);
  assert.equal((await db.query("select 1 from pg_namespace where nspname='mensageria'")).rows.length, 0);
  await db.exec(up);
});
