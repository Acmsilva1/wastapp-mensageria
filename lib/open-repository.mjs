import path from 'node:path';

export async function openRepository(env = process.env) {
  if (!env.DATABASE_URL) {
    const { VolumeRepository } = await import('./volume-repository.mjs');
    return VolumeRepository.open(path.resolve(env.WHATSAPP_DATA_PATH || '.runtime/whatsapp'));
  }
  const { database } = await import('./db.mjs');
  const { Repository } = await import('./repository.mjs');
  return new Repository(database(env));
}

export async function closeRepository(env = process.env) {
  if (!env.DATABASE_URL) return;
  const { database } = await import('./db.mjs');
  await database(env).end();
}
