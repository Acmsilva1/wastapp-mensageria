import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../lib/http-handler.mjs';
import { DemoRepository } from '../lib/demo-repository.mjs';
import { openRepository } from '../lib/open-repository.mjs';
const demo = process.argv.includes('--demo');
if (demo && process.env.VERCEL) throw new Error('demo_local_only');
const port = Number(process.env.PORT || 3338);
const origin = `http://127.0.0.1:${port}`;
const repository = demo ? new DemoRepository() : await openRepository();
const handler = createHandler({ repository, demo, env: demo ? { ...process.env, APP_ORIGIN: origin } : process.env });
const routes = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
  const pathname = new URL(req.url, origin).pathname;
  if (pathname === '/api/control') return handler(req, res);
  const route = routes[pathname];
  if (!route || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': route[1] }); res.end(await readFile(new URL(`../public/${route[0]}`, import.meta.url))); }
  catch { res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Painel ${demo ? 'DEMO (sem envios)' : 'real'}: ${origin}`));
