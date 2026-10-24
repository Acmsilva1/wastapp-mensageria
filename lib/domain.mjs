import { createHash } from 'node:crypto';
export const EVENTS = {
  'health.water_progress': 'Água',
  'health.diet_menu': 'Dieta',
  'financeiro.daily_summary': 'Resumo financeiro'
};
// O Super App manda um unico evento financeiro no perfil admin. A mensageria entrega a quem tiver a flag, em qualquer perfil.
export const DELEGATED_EVENT = 'financeiro.daily_summary';
export function recipientAccepts(recipient, notice) {
  if (!recipient?.enabled || !recipient.events?.includes(notice.event_type)) return false;
  if (notice.event_type === DELEGATED_EVENT) return true;
  return recipient.audience === notice.audience;
}
export class AppError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function invalid() { throw new AppError(400, 'invalid_input'); }
function str(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(); return value.trim(); }
export function recipientInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const name = str(data.name, 80);
  const target_type = data.target_type ?? 'phone';
  let phone = null, group_id = null;
  if (target_type === 'phone') {
    if (data.group_id != null && data.group_id !== '') invalid();
    phone = str(data.phone, 30).replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new AppError(400, 'phone_requires_country_code');
  } else if (target_type === 'group') {
    if (data.phone != null && data.phone !== '') invalid();
    group_id = str(data.group_id, 100);
    if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(group_id)) throw new AppError(400, 'invalid_group_id');
  } else invalid();
  const audience = str(data.audience, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/.test(audience)) invalid();
  if (!Array.isArray(data.events) || !data.events.length || data.events.length > 3 || data.events.some(e => !Object.hasOwn(EVENTS, e))) invalid();
  return { name, phone, target_type, group_id, audience, events: [...new Set(data.events)], enabled: data.enabled !== false };
}
export function alertInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const source = str(data.source, 30);
  if (!['superapp', 'jarvis'].includes(source)) invalid();
  const idempotency_key = str(data.idempotency_key, 180);
  const audience = str(data.audience, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/.test(audience) || !Object.hasOwn(EVENTS, data.event_type)) invalid();
  return { source, idempotency_key, audience, event_type: data.event_type, title: str(data.title, 120), message: str(data.message, 3500) };
}
export const payloadHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
