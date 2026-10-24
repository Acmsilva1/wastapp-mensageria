import { rm } from 'node:fs/promises';
import path from 'node:path';

// Perfil LocalAuth e restos do RemoteAuth. Nao inclui mensageria.json nem session-fingerprint.
export const PAIRING_SESSION_NAMES = ['session-mensageria', 'RemoteAuth-mensageria', 'RemoteAuth-mensageria.zip', 'wwebjs_temp_session_mensageria'];

export async function removeSessionArtifacts(dataPath, remove = rm) {
  const root = path.resolve(dataPath);
  for (const name of PAIRING_SESSION_NAMES) {
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root) throw new Error('invalid_session_path');
    await remove(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

// Chamado antes de criar o Client. Sem Chromium ou backup concorrente desta instancia.
export async function resetPairingIfRequested(repo, worker, dataPath, remove = rm) {
  const request = await repo.pendingPairingReset(worker);
  if (!request) return false;
  await removeSessionArtifacts(dataPath, remove);
  // Marca concluido junto com exclusao do perfil; falha antes disso repete no proximo boot.
  await repo.completePairingReset(worker, request);
  return true;
}

// Sem QR atualizado por 90s: reinicia somente a tentativa ainda nao autenticada.
export function qrRenewalStalled(lastQRAt, now = Date.now()) {
  return lastQRAt > 0 && now - lastQRAt > 90000;
}

// QR novo so no logout do celular (disconnected LOGOUT, inclusive post_logout).
// auth_failure de rede, TIMEOUT, UNLAUNCHED e CONFLICT mantem o perfil no volume.
export function needsFreshPairing(event, reason) {
  return event === 'disconnected' && reason === 'LOGOUT';
}
