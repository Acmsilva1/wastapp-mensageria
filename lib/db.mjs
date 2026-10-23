import pg from 'pg';
let pool;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_required');
  if (!pool) {
    let connection;
    try { connection = new URL(process.env.DATABASE_URL); }
    catch { throw new Error('DATABASE_URL_invalid'); }
    if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL_invalid');
    // Configuracao TLS explicita: nao permitir sslmode da URL desabilitar verificacao.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connection.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: connection.toString(), max: 3, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000, ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) } });
    pool.on('error', () => console.error('database_pool_error'));
  }
  return pool;
}
