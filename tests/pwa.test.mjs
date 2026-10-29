import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = new URL('../', import.meta.url);

test('PWA fornece manifest standalone e icones PNG com tamanhos reais', async () => {
  const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', root), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.lang, 'pt-BR');
  for (const size of [192, 512]) {
    const icons = manifest.icons.filter(icon => icon.sizes === `${size}x${size}`);
    assert.ok(icons.some(icon => icon.purpose === 'any'));
    assert.ok(icons.some(icon => icon.purpose === 'maskable'));
    const icon = await readFile(new URL(`public${icons[0].src}`, root));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
});

function worker(source, fetchImpl) {
  const events = {}, cached = [], matched = [];
  const fallback = { offline: true };
  const sandbox = {
    URL,
    fetch: fetchImpl,
    self: { location: { origin: 'https://mensageria.test' }, addEventListener: (name, fn) => { events[name] = fn; }, clients: { claim: async () => {} } },
    caches: { open: async () => ({ addAll: async paths => cached.push(...paths), match: async path => { matched.push(path); return fallback; } }), keys: async () => [] }
  };
  vm.runInNewContext(source, sandbox);
  return { events, cached, matched, fallback };
}

test('service worker deixa APIs, POST e outras origens fora do cache e da interceptacao', async () => {
  const source = await readFile(new URL('public/sw.js', root), 'utf8');
  const instance = worker(source, async () => ({ online: true }));
  const eventFor = (path, method = 'GET', mode = 'cors') => {
    let intercepted = false;
    instance.events.fetch({ request: { method, mode, url: path }, respondWith: () => { intercepted = true; } });
    return intercepted;
  };
  assert.equal(eventFor('https://mensageria.test/api/control?action=status'), false);
  assert.equal(eventFor('https://mensageria.test/api/control?action=login', 'POST'), false);
  assert.equal(eventFor('https://mensageria.test/api/control?action=pairing-reset', 'POST'), false);
  assert.equal(eventFor('https://external.test/offline.html'), false);
  assert.equal(eventFor('https://mensageria.test/app.js'), false);
  assert.equal(eventFor('https://mensageria.test/qr.png'), false);
  let installation;
  instance.events.install({ waitUntil: promise => { installation = promise; } });
  await installation;
  assert.deepEqual(instance.cached, ['/offline.html', '/pwa-offline.css', '/icons/icon-192.png', '/icons/icon-512.png']);
  assert.ok(!instance.cached.includes('/'));
  assert.ok(!instance.cached.some(path => /api|session|qr|index.html/.test(path)));
});

test('navegacao exige rede e usa somente pagina publica quando offline', async () => {
  const source = await readFile(new URL('public/sw.js', root), 'utf8');
  for (const online of [true, false]) {
    const response = { authenticatedPage: true };
    const instance = worker(source, async () => { if (!online) throw new Error('offline'); return response; });
    let promise;
    instance.events.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://mensageria.test/' }, respondWith: value => { promise = value; } });
    assert.equal(await promise, online ? response : instance.fallback);
    assert.deepEqual(instance.matched, online ? [] : ['/offline.html']);
  }
});

test('servidor demo entrega rotas PWA e nao permite enviar mensagens reais', async t => {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--demo'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Demo startup timeout')), 8000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`http://127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Demo exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const path of ['/', '/manifest.webmanifest', '/sw.js', '/pwa.js', '/pwa.css', '/ui.js', '/ui.css', '/visual.css', '/offline.html', '/pwa-offline.css', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
  }
  const manifest = await fetch(base + '/manifest.webmanifest');
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.headers.get('content-type'), /^text\/javascript/);
  const session = await (await fetch(base + '/api/control?action=session')).json();
  assert.equal(session.demo, true);
  const denied = await fetch(base + '/api/control?action=event', { method: 'POST', headers: { Origin: base, 'X-Panel-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(base + '/.env.local')).status, 404);
});
