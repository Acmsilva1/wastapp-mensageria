import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, payloadHash } from './domain.mjs';

const LEASE_MS = 90000;
const QR_MS = 45000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }
function emptyData() {
  return {
    state: {
      worker_id: null, lease_until: null, status: 'offline', account_name: null, account_phone: null,
      qr_encrypted: null, qr_expires_at: null, session_saved_at: null, updated_at: nowIso(),
      pairing_request_id: null, pairing_completed_id: null
    },
    recipients: [],
    ingress: [],
    deliveries: [],
    groups: { groups: [], requested_at: 0, started_at: 0, finished_at: 0, error: null }
  };
}
function normalize(parsed) {
  const base = emptyData();
  if (!parsed || typeof parsed !== 'object') return base;
  const groups = parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {};
  return {
    state: { ...base.state, ...(parsed.state || {}) },
    recipients: Array.isArray(parsed.recipients) ? parsed.recipients : [],
    ingress: Array.isArray(parsed.ingress) ? parsed.ingress : [],
    deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
    groups: { ...base.groups, ...groups, groups: Array.isArray(groups.groups) ? groups.groups : [] }
  };
}
function alive(state, worker) {
  return state.worker_id === worker && Date.parse(state.lease_until || '') > Date.now();
}
function paired(state) { return state.pairing_request_id === state.pairing_completed_id; }
function online(state) {
  return state.status === 'connected' && Date.parse(state.lease_until || '') > Date.now() && paired(state);
}
function dropDelivery(data, id) {
  const index = data.deliveries.findIndex(item => item.id === id);
  if (index < 0) return;
  const [job] = data.deliveries.splice(index, 1);
  if (!data.deliveries.some(item => item.source === job.source && item.idempotency_key === job.idempotency_key)) {
    data.ingress = data.ingress.filter(item => item.source !== job.source || item.idempotency_key !== job.idempotency_key);
  }
}
function catalogView(groups) {
  const requested = groups.requested_at || 0;
  const started = groups.started_at || 0;
  const finished = groups.finished_at || 0;
  const pending = !finished || requested > started || started > finished;
  const failed = !pending && Boolean(groups.error);
  const error = !failed ? null : ['group_lookup_timeout', 'group_catalog_unavailable', 'group_catalog_failed'].includes(groups.error) ? groups.error : 'group_catalog_failed';
  return { status: pending ? 'pending' : failed ? 'failed' : 'ready', updated_at: finished ? new Date(finished).toISOString() : null, error };
}
async function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  for (let attempt = 0; attempt < 80; attempt++) {
    let handle;
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 15000) await rm(lock, { force: true });
      } catch {}
      await sleep(25);
      continue;
    }
    try { return await fn(); }
    finally { await handle.close(); await rm(lock, { force: true }); }
  }
  throw new Error('volume_lock_timeout');
}
async function readData(file) {
  try { return normalize(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return emptyData(); throw error; }
}
async function writeData(file, data) {
  const payload = JSON.stringify({
    state: data.state, recipients: data.recipients, ingress: data.ingress, deliveries: data.deliveries, groups: data.groups
  });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, payload, { mode: 0o600 });
  await rename(temp, file);
}

export class VolumeRepository {
  constructor(dataPath) {
    this.dataPath = dataPath;
    this.file = path.join(dataPath, 'mensageria.json');
    this.logins = new Map();
  }
  static async open(dataPath) {
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    return new VolumeRepository(dataPath);
  }
  read() { return withLock(this.dataPath, async () => structuredClone(await readData(this.file))); }
  mutate(fn) {
    return withLock(this.dataPath, async () => {
      const data = await readData(this.file);
      const result = await fn(data);
      await writeData(this.file, data);
      return result;
    });
  }
  async allowLogin(fingerprint) {
    const now = Date.now();
    let row = this.logins.get(fingerprint);
    if (!row || row.expiresAt <= now) {
      row = { attempts: 0, expiresAt: now + LOGIN_WINDOW_MS };
      this.logins.set(fingerprint, row);
    }
    row.attempts += 1;
    return row.attempts <= 10;
  }
  async recipients() {
    const data = await this.read();
    return [...data.recipients].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  async recipient(id) {
    const data = await this.read();
    const row = data.recipients.find(item => item.id === id);
    return row ? { ...row, events: [...row.events] } : null;
  }
  async groups() {
    const data = await this.read();
    if (!online(data.state)) return [];
    return data.groups.groups.map(group => ({ id: group.id, name: group.name }));
  }
  async groupCatalog() {
    const data = await this.read();
    if (!online(data.state)) return { groups: [], catalog: { status: 'offline', updated_at: null, error: null } };
    return { groups: data.groups.groups.map(group => ({ id: group.id, name: group.name })), catalog: catalogView(data.groups) };
  }
  async requestGroupRefresh() {
    await this.mutate(data => {
      if (!online(data.state)) throw new AppError(409, 'group_connection_required');
      if (!(data.groups.requested_at > data.groups.started_at)) data.groups.requested_at = Date.now();
    });
  }
  async pendingGroupRefresh(worker) {
    const data = await this.read();
    return data.state.worker_id === worker && data.groups.requested_at > data.groups.started_at;
  }
  async beginGroupSync(worker) {
    await this.mutate(data => {
      if (!alive(data.state, worker) || data.state.status !== 'connected') throw new Error('worker_lease_lost');
      data.groups.started_at = Date.now();
    });
  }
  async syncGroups(worker, groups) {
    await this.mutate(data => {
      if (!alive(data.state, worker) || data.state.status !== 'connected') throw new Error('worker_lease_lost');
      data.groups.groups = groups.map(group => ({ id: group.id, name: group.name }));
      data.groups.finished_at = Date.now();
      data.groups.error = null;
    });
  }
  async failGroupSync(worker, code) {
    await this.mutate(data => {
      if (data.state.worker_id !== worker) return;
      data.groups.finished_at = Date.now();
      data.groups.error = code || 'group_catalog_failed';
    });
  }
  async saveRecipient(input) {
    let saved;
    await this.mutate(data => {
      const group = input.target_type === 'group';
      if (group && (!online(data.state) || !data.groups.groups.some(item => item.id === input.group_id))) throw new AppError(409, 'group_not_available');
      const match = item => group ? item.group_id === input.group_id && item.audience === input.audience : item.phone === input.phone && item.audience === input.audience;
      const current = data.recipients.find(match);
      const stamp = nowIso();
      if (current) {
        current.name = input.name;
        current.events = [...input.events];
        current.enabled = input.enabled;
        current.updated_at = stamp;
        saved = { ...current, events: [...current.events] };
      } else {
        saved = {
          id: randomUUID(), name: input.name, phone: input.phone, target_type: group ? 'group' : 'phone', group_id: input.group_id || null,
          audience: input.audience, events: [...input.events], enabled: input.enabled, created_at: stamp, updated_at: stamp
        };
        data.recipients.unshift(saved);
      }
    });
    return saved;
  }
  async toggleRecipient(id, enabled) {
    let found = false;
    await this.mutate(data => {
      const row = data.recipients.find(item => item.id === id);
      if (!row) return;
      row.enabled = enabled;
      row.updated_at = nowIso();
      found = true;
    });
    if (!found) throw new AppError(404, 'recipient_not_found');
  }
  async enqueue(alert) {
    let result;
    await this.mutate(data => {
      const hash = payloadHash(alert);
      const existing = data.ingress.find(item => item.source === alert.source && item.idempotency_key === alert.idempotency_key);
      if (existing) {
        if (existing.payload_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        result = {
          duplicate: true,
          jobs: data.deliveries.filter(item => item.source === alert.source && item.idempotency_key === alert.idempotency_key).map(item => ({ id: item.id, status: item.status }))
        };
        return;
      }
      const matches = data.recipients.filter(item => item.enabled && item.audience === alert.audience && item.events.includes(alert.event_type));
      if (!matches.length) throw new AppError(422, 'no_authorized_recipients');
      const stamp = nowIso();
      data.ingress.push({ source: alert.source, idempotency_key: alert.idempotency_key, payload_hash: hash, created_at: stamp });
      const jobs = [];
      for (const recipient of matches) {
        const job = {
          id: randomUUID(), source: alert.source, idempotency_key: alert.idempotency_key, recipient_id: recipient.id,
          audience: alert.audience, event_type: alert.event_type, title: alert.title, message: alert.message,
          status: 'pending', worker_id: null, whatsapp_id: null, error_code: null, created_at: stamp, started_at: null, finished_at: null
        };
        data.deliveries.push(job);
        jobs.push({ id: job.id, status: 'pending' });
      }
      result = { duplicate: false, jobs };
    });
    return result;
  }
  async snapshot() {
    const data = await this.read();
    const state = { ...data.state, qr_encrypted: data.state.qr_encrypted ? Buffer.from(data.state.qr_encrypted, 'base64') : null };
    const deliveries = data.deliveries
      .filter(item => item.status === 'pending' || item.status === 'sending')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 30)
      .map(item => ({
        id: item.id, event_type: item.event_type, status: item.status, error_code: item.error_code || null,
        created_at: item.created_at, finished_at: item.finished_at || null,
        name: data.recipients.find(recipient => recipient.id === item.recipient_id)?.name || ''
      }));
    return {
      state,
      recipients: [...data.recipients].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      deliveries,
      logs: []
    };
  }
  async lease(worker) {
    let granted = false;
    await this.mutate(data => {
      const free = !data.state.lease_until || Date.parse(data.state.lease_until) <= Date.now() || data.state.worker_id === worker;
      if (!free) return;
      data.state.worker_id = worker;
      data.state.lease_until = new Date(Date.now() + LEASE_MS).toISOString();
      data.state.updated_at = nowIso();
      granted = true;
    });
    return granted;
  }
  async state(worker, status, name = null, phone = null, qr = null) {
    await this.mutate(data => {
      if (!alive(data.state, worker)) throw new Error('worker_lease_lost');
      const showQR = status === 'qr' && qr;
      data.state.status = status;
      data.state.account_name = name;
      data.state.account_phone = phone;
      data.state.qr_encrypted = showQR ? Buffer.from(qr).toString('base64') : null;
      data.state.qr_expires_at = showQR ? new Date(Date.now() + QR_MS).toISOString() : null;
      data.state.updated_at = nowIso();
    });
  }
  async requestPairingReset() {
    let id;
    await this.mutate(data => {
      if (data.state.pairing_request_id && data.state.pairing_request_id !== data.state.pairing_completed_id) id = data.state.pairing_request_id;
      else id = data.state.pairing_request_id = randomUUID();
      data.state.qr_encrypted = null;
      data.state.qr_expires_at = null;
      data.state.updated_at = nowIso();
    });
    if (!id) throw new Error('connection_state_missing');
    return id;
  }
  async pendingPairingReset(worker) {
    const data = await this.read();
    if (!alive(data.state, worker) || data.state.pairing_request_id === data.state.pairing_completed_id) return null;
    return data.state.pairing_request_id || null;
  }
  async completePairingReset(worker, request) {
    await this.mutate(data => {
      if (!alive(data.state, worker) || data.state.pairing_request_id !== request) throw new Error('worker_lease_lost');
      data.state.pairing_completed_id = request;
      data.state.session_saved_at = null;
      data.state.status = 'connecting';
      data.state.account_name = null;
      data.state.account_phone = null;
      data.state.qr_encrypted = null;
      data.state.qr_expires_at = null;
      data.state.updated_at = nowIso();
    });
  }
  async heartbeat(worker) {
    await this.mutate(data => {
      if (!alive(data.state, worker)) throw new Error('worker_lease_lost');
      data.state.lease_until = new Date(Date.now() + LEASE_MS).toISOString();
      data.state.updated_at = nowIso();
    });
  }
  async release(worker) {
    await this.mutate(data => {
      if (data.state.worker_id !== worker) return;
      data.state.lease_until = new Date(Date.now() - 1000).toISOString();
      data.state.updated_at = nowIso();
    });
  }
  async forgetPairedAccount() {
    await this.mutate(data => {
      data.state.status = 'connecting';
      data.state.account_name = null;
      data.state.account_phone = null;
      data.state.qr_encrypted = null;
      data.state.qr_expires_at = null;
      data.state.session_saved_at = null;
      data.state.updated_at = nowIso();
    });
  }
  async markSessionSaved(worker) {
    await this.mutate(data => {
      if (!alive(data.state, worker)) throw new Error('worker_lease_lost');
      data.state.session_saved_at = nowIso();
      data.state.updated_at = data.state.session_saved_at;
    });
  }
  async log() {}
  async claim(worker) {
    let job = null;
    await this.mutate(data => {
      if (!alive(data.state, worker)) throw new Error('worker_lease_lost');
      for (const item of [...data.deliveries]) if (item.status === 'sending' && item.worker_id !== worker) dropDelivery(data, item.id);
      for (const item of [...data.deliveries]) {
        if (item.status !== 'pending') continue;
        const recipient = data.recipients.find(row => row.id === item.recipient_id);
        if (!recipient?.enabled || recipient.audience !== item.audience || !recipient.events.includes(item.event_type)) dropDelivery(data, item.id);
      }
      const pending = data.deliveries.filter(item => item.status === 'pending').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (!pending.length) return;
      const next = pending[0];
      next.status = 'sending';
      next.worker_id = worker;
      next.started_at = nowIso();
      const recipient = data.recipients.find(row => row.id === next.recipient_id);
      job = { ...next, events: undefined, phone: recipient?.phone || null, target_type: recipient?.target_type || 'phone', group_id: recipient?.group_id || null };
    });
    return job;
  }
  async finish(worker, id) {
    await this.mutate(data => {
      const job = data.deliveries.find(item => item.id === id && item.worker_id === worker && item.status === 'sending');
      if (job) dropDelivery(data, job.id);
    });
  }
  async cleanup() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    await this.mutate(data => {
      for (const item of [...data.deliveries]) if (item.status === 'pending' && Date.parse(item.created_at) < cutoff) dropDelivery(data, item.id);
    });
    for (const [key, row] of this.logins) if (row.expiresAt <= Date.now()) this.logins.delete(key);
  }
}
