import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
const roots = ['lib', 'api', 'worker', 'scripts', 'tests', 'public'];
for (const root of roots) for (const file of await readdir(root)) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', `${root}/${file}`], { stdio: 'inherit' });
  if (result.status) process.exit(result.status || 1);
}
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
if (config.daemons.whatsapp.instances.iad1 !== 1 || config.outputDirectory !== 'public') throw new Error('Invalid deployment layout');
console.log('Sintaxe e estrutura de deploy: OK');
