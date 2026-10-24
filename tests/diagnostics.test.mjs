import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { diagnose, logFailure } from '../lib/diagnostics.mjs';
import { poolConfig } from '../lib/db.mjs';
import { createHandler } from '../lib/http-handler.mjs';

test('diagnostico distingue falhas PostgreSQL e TLS sem expor dados', () => {
  assert.equal(diagnose({ code: '28P01' }).error, 'database_auth_failed');
  assert.equal(diagnose({ code: '42P01' }).error, 'database_schema_missing');
  assert.equal(diagnose({ code: '42501' }).error, 'database_permission_denied');
  assert.equal(diagnose({ cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }).error, 'database_tls_error');
  assert.equal(diagnose({ errors: [{ code: 'ENETUNREACH' }] }).error, 'database_unreachable');
  assert.equal(diagnose(new Error('Connection terminated due to connection timeout')).error, 'database_timeout');
  assert.equal(diagnose(new Error('timeout exceeded when trying to connect')).error, 'database_timeout');
  assert.equal(diagnose(new Error('Query read timeout')).error, 'database_timeout');
  assert.equal(diagnose(new Error('Connection terminated unexpectedly')).error, 'database_connection_reset');
  assert.equal(diagnose(new Error('MaxClientsInSessionMode: max clients reached')).error, 'database_connection_limit');
  const apiPool = poolConfig({ DATABASE_URL: 'postgresql://app:secret@pooler.supabase.com:6543/postgres' });
  const daemonPool = poolConfig({ DATABASE_URL: 'postgresql://app:secret@pooler.supabase.com:6543/postgres', WHATSAPP_DATA_PATH: '/app/.runtime/whatsapp' });
  assert.equal(apiPool.max, 1);
  assert.equal(apiPool.query_timeout, 8000);
  assert.equal(apiPool.allowExitOnIdle, true);
  assert.equal(apiPool.idleTimeoutMillis, 5000);
  assert.equal(daemonPool.max, 3);
  assert.equal(daemonPool.allowExitOnIdle, false);
  assert.equal(diagnose(new Error('No usable sandbox!')).error, 'chromium_sandbox_unavailable');
  const original = console.error; const lines = [];
  console.error = value => lines.push(value);
  try { logFailure('control_request_failed', { code: '28P01', message: 'postgresql://user:SECRET@host/db', stack: 'SECRET' }); }
  finally { console.error = original; }
  assert.equal(lines[0].includes('SECRET'), false);
  assert.equal(JSON.parse(lines[0]).code, '28P01');
});
test('login retorna o motivo sanitizado quando a migration esta ausente', async () => {
  const env = { APP_ORIGIN: 'https://test.example', ADMIN_TOKEN: 'a'.repeat(64), INTEGRATION_TOKEN: 'b'.repeat(64) };
  const repository = { allowLogin: async () => { throw Object.assign(new Error('SQL com dados privados'), { code: '42P01' }); } };
  const server = http.createServer(createHandler({ repository, env }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control?action=login`, {
      method: 'POST', headers: { Origin: env.APP_ORIGIN, 'X-Panel-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: env.ADMIN_TOKEN })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'database_schema_missing' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
