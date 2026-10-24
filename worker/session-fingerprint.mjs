import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { removeSessionArtifacts } from './pairing-reset.mjs';

// Codigo que mantem a sessao. Painel, public e group-target nao entram: nao pedem QR novo.
export const SESSION_CODE_FILES = [
  'worker/index.mjs',
  'worker/pairing-reset.mjs',
  'worker/volume-auth.mjs',
  'worker/session-fingerprint.mjs'
];

export function buildFingerprint(version, entries) {
  const hash = createHash('sha256');
  hash.update('version\0');
  hash.update(String(version));
  hash.update('\0');
  for (const [name, content] of entries) {
    hash.update(name);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function sessionFingerprint() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const entries = [];
  for (const name of SESSION_CODE_FILES) entries.push([name, await readFile(new URL(`../${name}`, import.meta.url))]);
  return buildFingerprint(pkg.version, entries);
}

// Fingerprint ausente nao apaga. Diferente apaga so o perfil de pareamento e grava o novo.
export async function applySessionFingerprint(dataPath, fingerprint, io = {}) {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint || '')) throw new Error('invalid_session_fingerprint');
  const read = io.readFile || readFile;
  const write = io.writeFile || writeFile;
  const remove = io.remove;
  const root = path.resolve(dataPath);
  const file = path.join(root, 'session-fingerprint');
  let previous = null;
  try { previous = String(await read(file, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const changed = previous !== null && previous !== fingerprint;
  if (changed) await removeSessionArtifacts(root, remove);
  if (previous !== fingerprint) await write(file, `${fingerprint}\n`, { mode: 0o600 });
  return changed;
}
