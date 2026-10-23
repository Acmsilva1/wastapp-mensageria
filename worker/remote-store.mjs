import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { encrypt, decrypt } from '../lib/crypto.mjs';
export class EncryptedStore {
  constructor(repo, key, dataPath, workerId) { Object.assign(this, { repo, key, dataPath, workerId }); }
  async sessionExists({ session }) { return (await this.repo.query('select 1 from mensageria.session_backups where name=$1', [session])).rows.length > 0; }
  async save({ session }) {
    const location = path.join(this.dataPath, `${session}.zip`);
    if ((await stat(location)).size > 128 * 1024 * 1024 - 29) throw new Error('session_backup_too_large');
    const archive = encrypt(await readFile(location), this.key);
    // Lease impede que uma instancia antiga sobrescreva o backup da instancia atual.
    const { rows } = await this.repo.query(`insert into mensageria.session_backups(name,encrypted_archive)
      select $1,$2 where exists(select 1 from mensageria.connection_state where id=1 and worker_id=$3 and lease_until>now())
      on conflict(name) do update set encrypted_archive=excluded.encrypted_archive,updated_at=now() returning name`, [session, archive, this.workerId]);
    if (!rows.length) throw new Error('worker_lease_lost');
    await this.repo.query('update mensageria.connection_state set session_saved_at=now() where id=1 and worker_id=$1', [this.workerId]);
  }
  async extract({ session, path: output }) {
    const row = (await this.repo.query('select encrypted_archive from mensageria.session_backups where name=$1', [session])).rows[0];
    if (!row) throw new Error('session_backup_missing');
    await writeFile(output, decrypt(row.encrypted_archive, this.key), { mode: 0o600 });
  }
  async delete({ session }) {
    await this.repo.query(`delete from mensageria.session_backups where name=$1 and exists(select 1 from mensageria.connection_state where id=1 and worker_id=$2 and lease_until>now())`, [session, this.workerId]);
    await this.repo.query('update mensageria.connection_state set session_saved_at=null where id=1 and worker_id=$1 and lease_until>now()', [this.workerId]);
  }
}
