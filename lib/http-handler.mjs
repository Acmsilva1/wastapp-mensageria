import {createAgentService} from './agent-channel.mjs';
import { logFailure } from './diagnostics.mjs';
import { createHash } from 'node:crypto';
import { AppError, EVENTS, alertInput, recipientInput, interactionRecipient, interactionVersion } from './domain.mjs';
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
  const agentAvailable=!demo && !env.VERCEL && !env.DATABASE_URL && typeof repository.dataPath==='string';
  const agents=()=>createAgentService({repository,dataPath:repository.dataPath});
  const agentCapability={version:2,available:agentAvailable};
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
      if (!['event','interaction-authorize','agent-arm','agent-close'].includes(action) && mutating && (req.headers.origin !== origin || req.headers['x-panel-request'] !== '1')) throw new AppError(403, 'origin_rejected');
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
      if (action === 'session' && req.method === 'GET') return send(res, 200, { authenticated, demo, events: EVENTS, agent_channel:agentCapability });
      if (action === 'interaction-authorize' && req.method === 'POST') {
        if (demo) throw new AppError(403, 'interaction_forbidden');
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!equalSecret(bearer, env.INTEGRATION_TOKEN)) throw new AppError(401, 'invalid_integration_token');
        const body = await readBody(req);
        if (!body || !/^\+[1-9]\d{7,14}$/.test(body.sender_phone || '') || body.permission !== 'purchases.record'
          || typeof body.authorization_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.authorization_id) || typeof body.authorization_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.authorization_version)) throw new AppError(400, 'invalid_input');
        const recipient = interactionRecipient(await repository.recipients(), body.sender_phone, body.permission);
        if (!recipient || recipient.id !== body.authorization_id || interactionVersion(recipient) !== body.authorization_version) throw new AppError(403, 'interaction_forbidden');
        const senderPhone = recipient.phone || body.sender_phone;
        return send(res, 200, {ok:true,authorized:true,sender_phone:senderPhone,authorization_id:recipient.id,authorization_version:interactionVersion(recipient)});
      }
      if (action === 'event' && req.method === 'POST') {
        if (demo) throw new AppError(403, 'demo_no_delivery');
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!equalSecret(bearer, env.INTEGRATION_TOKEN)) throw new AppError(401, 'invalid_integration_token');
        let alert=alertInput(await readBody(req));
        if(alert.event_type==='agent.notice'){if(!agentAvailable)throw new AppError(503,'agent_channel_unavailable');alert=await agents().notice(alert);}
        return send(res, 202, { ok: true, ...await repository.enqueue(alert) });
      }
      if (['agent-arm','agent-inbox','agent-close'].includes(action)) {
        const bearer=(req.headers.authorization || '').replace(/^Bearer /,'');
        if (!equalSecret(bearer,env.INTEGRATION_TOKEN)) throw new AppError(401,'invalid_integration_token');
        if (!agentAvailable) throw new AppError(503,'agent_channel_unavailable');
        if (action==='agent-arm' && req.method==='POST') return send(res,202,await agents().arm(await readBody(req)));
        if (action==='agent-close' && req.method==='POST') return send(res,200,await agents().close(await readBody(req)));
        if (action==='agent-inbox' && req.method==='GET') {
          const q=new URL(req.url,origin).searchParams;
          return send(res,200,await agents().list({request_id:q.get('request_id'),project:q.get('project')},Number(q.get('since') || 0)));
        }
        throw new AppError(405,'method_not_allowed');
      }
      if (!authenticated) throw new AppError(401, 'authentication_required');
      if (action === 'pairing-reset' && req.method === 'POST') {
        if (demo) throw new AppError(403, 'demo_no_pairing');
        const body = await readBody(req);
        if (body?.confirm !== 'reset_pairing') throw new AppError(400, 'pairing_confirmation_required');
        await repository.requestPairingReset();
        return send(res, 202, { ok: true, pending: true });
      }
      if (action === 'snapshot' && req.method === 'GET') {
        const result = await repository.snapshot();
        const state = result.state || {};
        const online = new Date(state.lease_until || 0).getTime() > Date.now();
        const pairingPending = state.pairing_request_id != null && state.pairing_request_id !== state.pairing_completed_id;
        const freshQR = !pairingPending && online && state.status === 'qr' && new Date(state.qr_expires_at || 0).getTime() > Date.now();
        const qr = freshQR && state.qr_encrypted ? decrypt(state.qr_encrypted, encryptionKey(env)).toString() : null;
        return send(res, 200, { demo, events: EVENTS, agent_channel:agentCapability, ...result, state: {
          pairing_pending: pairingPending, status: pairingPending ? 'restarting' : online ? state.status : 'offline', account_name: online ? state.account_name : null,
          account_phone: online ? state.account_phone : null, updated_at: state.updated_at,
          session_saved_at: state.session_saved_at, qr
        } });
      }
      if (action === 'groups' && req.method === 'GET') return send(res, 200, demo ? {groups:[],catalog:{status:'ready',updated_at:null,error:null}} : await repository.groupCatalog());
      if (action === 'groups-refresh' && req.method === 'POST') {
        if (!demo) await repository.requestGroupRefresh();
        return send(res,202,{ok:true,pending:true});
      }
      if (action === 'recipients' && req.method === 'POST') {
        const recipient=recipientInput(await readBody(req));
        if(recipient.events.includes('agent.notice')&&!agentAvailable)throw new AppError(503,'agent_channel_unavailable');
        return send(res,200,{ok:true,recipient:await repository.saveRecipient(recipient)});
      }
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
