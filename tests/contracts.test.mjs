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

let db, repo;
const up = await readFile(new URL('../migrations/001_mensageria.sql', import.meta.url), 'utf8');
const down = await readFile(new URL('../migrations/001_rollback.sql', import.meta.url), 'utf8');
before(async () => {
  db = new PGlite();
  await db.exec(up);
  repo = new Repository({ query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) });
});
after(async () => { await db.close(); });
async function reset() {
  await db.exec('truncate mensageria.deliveries,mensageria.ingress,mensageria.recipients,mensageria.session_backups,mensageria.connection_logs,mensageria.login_limits; update mensageria.connection_state set worker_id=null,lease_until=null,status=\'offline\',qr_encrypted=null,qr_expires_at=null,account_phone=null,session_saved_at=null;');
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
test('migration e rollback funcionam e RLS esta habilitada em todas as tabelas', async () => {
  const rows = (await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='mensageria' and relkind='r'")).rows;
  assert.equal(rows.length, 7); assert.ok(rows.every(r => r.relrowsecurity));
  await db.exec(down);
  assert.equal((await db.query("select 1 from pg_namespace where nspname='mensageria'")).rows.length, 0);
  await db.exec(up);
});
