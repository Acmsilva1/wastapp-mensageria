import { rm } from 'node:fs/promises';
import path from 'node:path';
// Chamado antes de criar o Client. Sem Chromium ou backup concorrente desta instancia.
export async function resetPairingIfRequested(repo, worker, dataPath, remove = rm) {
  const request = await repo.pendingPairingReset(worker);
  if (!request) return false;
  const root = path.resolve(dataPath);
  for (const name of ['RemoteAuth-mensageria', 'RemoteAuth-mensageria.zip', 'wwebjs_temp_session_mensageria']) {
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root) throw new Error('invalid_session_path');
    await remove(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
  // Marca concluido junto com exclusao do backup; falha antes disso repete no proximo boot.
  await repo.completePairingReset(worker, request);
  return true;
}
// Sem QR atualizado por 90s: reinicia somente a tentativa ainda nao autenticada.
export function qrRenewalStalled(lastQRAt, now = Date.now()) {
  return lastQRAt > 0 && now - lastQRAt > 90000;
}
export function needsFreshPairing(event, reason) {
  return event === 'auth_failure' || (event === 'disconnected' && reason === 'LOGOUT');
}
