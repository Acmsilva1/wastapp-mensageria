import { logFailure } from './diagnostics.mjs';
import { createHash } from 'node:crypto';
import { AppError, EVENTS, alertInput, recipientInput } from './domain.mjs';
import { decrypt, encryptionKey, equalSecret, makeSession, validSession } from './crypto.mjs';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > 16384) throw new AppError(413, 'body_too_large');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'json_required');
  if (req.body && typeof req.body === 'object') {
    if (JSON.stringify(req.body).length > 16384) throw new AppError(413, 'body_too_large');
    return req.body;
  }
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new AppError(413, 'body_too_large'); }
  try { return JSON.parse(body); } catch { throw new AppError(400, 'invalid_json'); }
}
export function createHandler({ repository, env = process.env, demo = false }) {
  if (demo && (env.VERCEL || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.APP_ORIGIN || ''))) throw new Error('demo_local_only');
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const origin = env.APP_ORIGIN;
      if (!origin || (!demo && (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !env.INTEGRATION_TOKEN || env.INTEGRATION_TOKEN.length < 32 || equalSecret(env.ADMIN_TOKEN, env.INTEGRATION_TOKEN)))) throw new AppError(503, 'configuration_required');
      if (env.VERCEL && !origin.startsWith('https://')) throw new AppError(503, 'https_origin_required');
      const action = new URL(req.url, origin).searchParams.get('action') || 'session';
      const cookie = /(?:^|;\s*)wm_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
      const authenticated = demo || validSession(cookie, env.ADMIN_TOKEN);
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (action !== 'event' && mutating && (req.headers.origin !== origin || req.headers['x-panel-request'] !== '1')) throw new AppError(403, 'origin_rejected');
      const secure = origin.startsWith('https:') ? '; Secure' : '';
      if (action === 'login' && req.method === 'POST') {
        const ip = req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        const fingerprint = createHash('sha256').update(String(ip)).digest('hex');
        if (!await repository.allowLogin('global') || !await repository.allowLogin(fingerprint)) throw new AppError(429, 'login_rate_limited');
        const body = await readBody(req);
        if (!equalSecret(body.token, env.ADMIN_TOKEN)) throw new AppError(401, 'invalid_credentials');
        res.setHeader('Set-Cookie', `wm_session=${makeSession(env.ADMIN_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`);
        return send(res, 200, { ok: true });
      }
      if (action === 'logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', `wm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
        return send(res, 200, { ok: true });
      }
      if (action === 'session' && req.method === 'GET') return send(res, 200, { authenticated, demo, events: EVENTS });
      if (action === 'event' && req.method === 'POST') {
        if (demo) throw new AppError(403, 'demo_no_delivery');
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!equalSecret(bearer, env.INTEGRATION_TOKEN)) throw new AppError(401, 'invalid_integration_token');
        return send(res, 202, { ok: true, ...await repository.enqueue(alertInput(await readBody(req))) });
      }
      if (!authenticated) throw new AppError(401, 'authentication_required');
      if (action === 'snapshot' && req.method === 'GET') {
        const result = await repository.snapshot();
        const state = result.state || {};
        const online = new Date(state.lease_until || 0).getTime() > Date.now();
        const freshQR = online && state.status === 'qr' && new Date(state.qr_expires_at || 0).getTime() > Date.now();
        const qr = freshQR && state.qr_encrypted ? decrypt(state.qr_encrypted, encryptionKey(env)).toString() : null;
        return send(res, 200, { demo, events: EVENTS, ...result, state: {
          status: online ? state.status : 'offline', account_name: online ? state.account_name : null,
          account_phone: online ? state.account_phone : null, updated_at: state.updated_at,
          session_saved_at: state.session_saved_at, qr
        } });
      }
      if (action === 'recipients' && req.method === 'POST') return send(res, 200, { ok: true, recipient: await repository.saveRecipient(recipientInput(await readBody(req))) });
      if (action === 'recipient-toggle' && req.method === 'POST') {
        const body = await readBody(req);
        if (!/^[a-f0-9-]{36}$/i.test(body.id || '') || typeof body.enabled !== 'boolean') throw new AppError(400, 'invalid_input');
        await repository.toggleRecipient(body.id, body.enabled);
        return send(res, 200, { ok: true });
      }
      throw new AppError(404, 'route_not_found');
    } catch (error) {
      const diagnostic = error instanceof AppError ? { error: error.code } : logFailure('control_request_failed', error);
      send(res, error instanceof AppError ? error.status : 503, { ok: false, error: diagnostic.error });
    }
  };
}
