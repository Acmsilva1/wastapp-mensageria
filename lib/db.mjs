import pg from 'pg';
let pool;
export function poolConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_required');
  let connection;
  try { connection = new URL(env.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL_invalid');
  // Configuracao TLS explicita: nao permitir sslmode da URL desabilitar verificacao.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connection.searchParams.delete(key);
  const persistent = Boolean(env.WHATSAPP_DATA_PATH);
  return {
    connectionString: connection.toString(),
    // A função abre uma conexão e devolve quando fica ociosa. O daemon precisa de até três usos simultâneos.
    max: persistent ? 3 : 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: persistent ? 20000 : 5000,
    allowExitOnIdle: !persistent,
    query_timeout: 8000,
    ssl: { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) }
  };
}
export function database(env = process.env) {
  if (!pool) {
    pool = new pg.Pool(poolConfig(env));
    pool.on('error', () => console.error('database_pool_error'));
  }
  return pool;
}
