import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { diagnose, logFailure, sendDiagnostic } from '../lib/diagnostics.mjs';
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

test('falhas de envio distinguem biblioteca, contexto e ID ausente sem revelar dados', () => {
  const privateText='5511900000000 SECRET postgresql://user:password@host/db';
  const cases=[
    [new Error(`Evaluation failed: e.getLastMsgKeyForAction is not a function ${privateText}`),'send_seen_failed'],
    [{message:'Evaluation failed',stack:`at window.WWebJS.sendSeen ${privateText}`},'send_seen_failed'],
    [{message:'Evaluation failed',stack:`at window.WWebJS.getMessageModel ${privateText}`},'send_serialization_failed'],
    [new Error(`Execution context was destroyed ${privateText}`),'send_browser_context_lost'],
    [new Error('send_timeout'),'send_timeout'],
    [new Error('send_missing_message_id'),'send_missing_message_id'],
    [new Error('water_binding_failed'),'send_water_binding_failed'],
    [new Error(privateText),'send_unconfirmed'],
  ];
  for(const [error,code] of cases) {
    assert.equal(sendDiagnostic(error),code);
    assert.doesNotMatch(JSON.stringify({event:'whatsapp_send_failed',code:sendDiagnostic(error)}),/SECRET|5511900000000|password/);
  }
});

test('biblioteca real pode rejeitar antes do envio ou depois de enviar ao serializar o retorno', async () => {
  const { Client } = createRequire(import.meta.url)('whatsapp-web.js');
  const prior = globalThis.window;
  let sends=0;
  try {
    globalThis.window={WWebJS:{
      getChat:async()=>({}),
      sendSeen:async()=>{},
      sendMessage:async()=>{sends++;return {};},
      getMessageModel(){throw new Error('model unavailable');}
    }};
    const client={pupPage:{evaluate:(callback,...args)=>callback(...args)}};
    await assert.rejects(Client.prototype.sendMessage.call(client,'5511900000000@c.us','conteudo ficticio'),error=>sendDiagnostic(error)==='send_serialization_failed');
    assert.equal(sends,1,'falha de serializacao acontece depois do envio');
    globalThis.window.WWebJS.sendSeen=async()=>{throw new Error('getLastMsgKeyForAction is not a function');};
    await assert.rejects(Client.prototype.sendMessage.call(client,'5511900000000@c.us','conteudo ficticio'),error=>sendDiagnostic(error)==='send_seen_failed');
    assert.equal(sends,1,'falha sendSeen impede chamar envio');
  } finally {
    if(prior===undefined) delete globalThis.window;else globalThis.window=prior;
  }
});
