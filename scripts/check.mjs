import './sync-pwa-version.mjs';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
const roots = ['lib', 'api', 'worker', 'scripts', 'tests', 'public'];
for (const root of roots) for (const file of await readdir(root)) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', `${root}/${file}`], { stdio: 'inherit' });
  if (result.status) process.exit(result.status || 1);
}
const config = JSON.parse((await readFile('vercel.json', 'utf8')).replace(/^\uFEFF/, ''));
if (config.daemons.whatsapp.instances.iad1 !== 1 || config.outputDirectory !== 'public') throw new Error('Invalid deployment layout');

// Mantem o Dockerfile e suas fontes COPY no contexto da raiz do repositorio.
if (config.daemons.whatsapp.root !== '.' || config.daemons.whatsapp.entrypoint !== 'Dockerfile.whatsapp') {
  throw new Error('O Dockerfile do WhatsApp deve usar o contexto da raiz do repositorio.');
}
for (const source of ['package.json', 'package-lock.json', 'lib/db.mjs', 'worker/index.mjs']) {
  await readFile(source);
}
await readFile('Dockerfile.whatsapp');
console.log('Sintaxe e estrutura de deploy: OK');
