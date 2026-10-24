// Nunca registrar error.message/stack: drivers podem incluir URLs e dados privados.
const codes = {
  '28P01': 'database_auth_failed', '28000': 'database_auth_failed',
  '42P01': 'database_schema_missing', '3F000': 'database_schema_missing', '42703': 'database_schema_outdated',
  '42501': 'database_permission_denied', '3D000': 'database_name_invalid',
  '53300': 'database_connection_limit', '57P03': 'database_unavailable',
  ECONNREFUSED: 'database_unreachable', ENOTFOUND: 'database_host_not_found', EAI_AGAIN: 'database_host_not_found',
  ENETUNREACH: 'database_unreachable', EHOSTUNREACH: 'database_unreachable',
  ETIMEDOUT: 'database_timeout', ECONNRESET: 'database_connection_reset',
  SELF_SIGNED_CERT_IN_CHAIN: 'database_tls_error', DEPTH_ZERO_SELF_SIGNED_CERT: 'database_tls_error',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'database_tls_error', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'database_tls_error',
  CERT_HAS_EXPIRED: 'database_tls_error', ERR_TLS_CERT_ALTNAME_INVALID: 'database_tls_error'
};
export function diagnose(error) {
  const queue = [error];
  for (let i = 0; i < queue.length && i < 8; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object') continue;
    if (Object.hasOwn(codes, item.code || '')) return { error: codes[item.code], code: item.code };
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 4));
  }
  const text = typeof error?.message === 'string' ? error.message : '';
  if (text === 'DATABASE_URL_required' || text === 'DATABASE_URL_invalid') return { error: 'database_configuration_invalid' };
  if (text === 'SESSION_ENCRYPTION_KEY_required') return { error: 'encryption_key_invalid' };
  if (/timeout.*connect|connect.*timeout|query read timeout/i.test(text)) return { error: 'database_timeout' };
  if (/too many clients|max clients|emaxconn|remaining connection slots|max client connections/i.test(text)) return { error: 'database_connection_limit' };
  if (/connection terminated|server closed the connection|connection ended unexpectedly/i.test(text)) return { error: 'database_connection_reset' };
  if (/no usable sandbox|failed to move to new namespace|running as root without --no-sandbox/i.test(text)) return { error: 'chromium_sandbox_unavailable' };
  if (/failed to launch (the )?browser|could not find (chrome|chromium)|browser.*executable/i.test(text)) return { error: 'chromium_start_failed' };
  return { error: 'service_unavailable' };
}
export function logFailure(event, error) {
  const diagnostic = diagnose(error);
  console.error(JSON.stringify({ event, ...diagnostic }));
  return diagnostic;
}
