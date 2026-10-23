import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const content = `# Privado. Nao versionar. Complete APP_ORIGIN e DATABASE_URL.\nAPP_ORIGIN=http://127.0.0.1:3338\nDATABASE_URL=\nDATABASE_CA_CERT=\nADMIN_TOKEN=${randomBytes(32).toString('hex')}\nINTEGRATION_TOKEN=${randomBytes(32).toString('hex')}\nSESSION_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`;
try {
  await writeFile('.env.local', content, { flag: 'wx', mode: 0o600 });
  console.log('Chaves gravadas em .env.local. O arquivo nao foi exibido e esta excluido do Git.');
} catch (error) {
  if (error.code === 'EEXIST') { console.error('.env.local ja existe; nada foi sobrescrito.'); process.exitCode = 1; }
  else throw error;
}
