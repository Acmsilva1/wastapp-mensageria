import { createHash } from 'node:crypto';
export const EVENTS = {
  'health.water_progress': 'Água',
  'health.diet_menu': 'Dieta',
  'financeiro.daily_summary': 'Resumo financeiro',
  'agent.notice': 'Aviso do agente'
};
export const INTERACTIONS = {
  'water.record': 'Registrar água no perfil vinculado',
  'purchases.record': 'Enviar compras com confirmação'
};
export function recipientPermits(recipient, permission) {
  if (recipient?.enabled !== true || recipient.target_type === 'group') return false;
  if (permission === 'water.record') return recipient.events?.includes('health.water_progress') === true;
  return Array.isArray(recipient.permissions) && recipient.permissions.includes(permission);
}
export function interactionVersion(recipient) {
  const stamp = recipient?.updated_at instanceof Date ? recipient.updated_at.toISOString() : recipient?.updated_at;
  return createHash('sha256').update(JSON.stringify([recipient?.id, stamp])).digest('hex');
}
export function interactionRecipient(rows, phone, permission) {
  const matches = rows.filter(row => recipientPermits(row, permission) && row.phone === phone);
  return matches.length === 1 ? matches[0] : null;
}
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
  const follow_session = data.follow_session === true;
  if (target_type === 'phone') {
    if (data.group_id != null && data.group_id !== '') invalid();
    if (follow_session) {
      if (data.phone != null && data.phone !== '') invalid();
    } else {
      phone = str(data.phone, 30).replace(/[\s().-]/g, '');
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new AppError(400, 'phone_requires_country_code');
    }
  } else if (target_type === 'group') {
    if (follow_session || (data.phone != null && data.phone !== '')) invalid();
    group_id = str(data.group_id, 100);
    if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(group_id)) throw new AppError(400, 'invalid_group_id');
  } else invalid();
  const audience = str(data.audience, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/.test(audience)) invalid();
  const requestedPermissions = data.permissions ?? [];
  if (!Array.isArray(requestedPermissions) || requestedPermissions.length > 2 || requestedPermissions.some(p => !Object.hasOwn(INTERACTIONS, p)) || target_type === 'group' && requestedPermissions.length) invalid();
  if (!Array.isArray(data.events) || data.events.length > 4 || data.events.some(e => !Object.hasOwn(EVENTS, e))) invalid();
  if (target_type === 'group' && data.events.includes('agent.notice')) throw new AppError(400,'agent_private_only');
  // Água has one switch. Keep the stored flag for compatibility with older workers.
  const permissions = requestedPermissions.filter(p => p !== 'water.record');
  if (target_type === 'phone' && data.events.includes('health.water_progress')) permissions.push('water.record');
  if (!data.events.length && !permissions.length) invalid();
  return { name, phone, target_type, group_id, audience, events: [...new Set(data.events)], permissions: [...new Set(permissions)], follow_session: target_type === 'phone' && follow_session, enabled: data.enabled !== false };
}
export function alertInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const source = str(data.source, 30);
  if (!['superapp', 'jarvis', 'agente'].includes(source)) invalid();
  const idempotency_key = str(data.idempotency_key, 180);
  const audience = str(data.audience ?? (source === 'agente' ? 'agente' : undefined), 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/.test(audience) || !Object.hasOwn(EVENTS, data.event_type)) invalid();
  if ((source === 'agente') !== (data.event_type === 'agent.notice')) invalid();
  if (data.event_type !== 'agent.notice' && (data.agent_request != null || data.agent_project != null)) invalid();
  const alert = { source, idempotency_key, audience, event_type: data.event_type, title: str(data.title, 120), message: str(data.message, 3500) };
  if (source === 'agente') {
    alert.agent_project = str(data.agent_project,120);
    if (/[\x00-\x1f\x7f]/.test(alert.agent_project)) invalid();
    if (data.agent_request != null) {
      const r=data.agent_request;
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join(',')!=='project,request_id' || r.project !== alert.agent_project || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.request_id || '')) invalid();
      alert.agent_request={request_id:r.request_id.toLowerCase(),project:r.project};
    }
  }
  if (data.water_prompt != null) {
    const p = data.water_prompt;
    if (source !== 'superapp' || data.event_type !== 'health.water_progress' || !p || typeof p !== 'object' || Array.isArray(p)
      || p.profile_id !== audience || p.dedupe_key !== idempotency_key || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')
      || !/^[a-f0-9]{64}$/.test(p.signature || '') || !idempotency_key.startsWith(`agua:${p.date}:`)) invalid();
    alert.water_prompt = { profile_id: audience, date: p.date, dedupe_key: idempotency_key, signature: p.signature };
  }
  return alert;
}
export const payloadHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
