import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
export function encryptionKey(env = process.env) {
  if (!/^[a-f0-9]{64}$/i.test(env.SESSION_ENCRYPTION_KEY || '')) throw new Error('SESSION_ENCRYPTION_KEY_required');
  return Buffer.from(env.SESSION_ENCRYPTION_KEY, 'hex');
}
export function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
export function decrypt(value, key) {
  const buffer = Buffer.from(value);
  if (buffer.length < 29 || buffer[0] !== 1) throw new Error('invalid_encrypted_data');
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(1, 13));
  decipher.setAuthTag(buffer.subarray(13, 29));
  return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]);
}
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const hash = x => createHmac('sha256', 'mensageria-compare').update(x).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function makeSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + 8 * 60 * 60 * 1000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function validSession(cookie, secret, now = Date.now()) {
  try {
    const [payload, signature, extra] = cookie.split('.');
    if (extra || !equalSecret(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) return false;
    const exp = JSON.parse(Buffer.from(payload, 'base64url')).exp;
    return Number.isFinite(exp) && exp > now && exp <= now + 8 * 60 * 60 * 1000;
  } catch { return false; }
}
