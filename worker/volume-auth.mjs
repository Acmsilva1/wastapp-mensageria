import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { LocalAuth } = require('whatsapp-web.js');

// LocalAuth grava o perfil em disco e nao apaga no disconnect().
// RemoteAuth.disconnect/logout e extractRemoteSession removem userDataDir e o backup.
export const SESSION_CLIENT_ID = 'mensageria';

export class VolumeAuth extends LocalAuth {
  constructor(options = {}) {
    super({ ...options, clientId: options.clientId || SESSION_CLIENT_ID });
  }

  // Queda transitoria: a lib chama disconnect() antes do evento. Nao remover o volume.
  async disconnect() {}

  // destroy() do Client chega aqui. Fechar o browser nao apaga o perfil.
  async destroy() {}

  async logout() {
    if (!this.userDataDir) return;
    const root = path.resolve(this.dataPath);
    const target = path.resolve(this.userDataDir);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid_session_path');
    await super.logout();
  }
}
