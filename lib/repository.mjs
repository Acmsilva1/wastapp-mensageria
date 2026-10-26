import { randomUUID } from 'node:crypto';
import { AppError, DELEGATED_EVENT, payloadHash } from './domain.mjs';
export class Repository {
  constructor(pool) { this.pool = pool; }
  query(sql, values = []) { return this.pool.query(sql, values); }
  async transaction(fn) {
    const connection = await this.pool.connect();
    try { await connection.query('begin'); const result = await fn(connection); await connection.query('commit'); return result; }
    catch (error) { await connection.query('rollback'); throw error; }
    finally { connection.release(); }
  }
  async recipients() { return (await this.query('select * from mensageria.recipients order by created_at desc')).rows; }
  async groups() {
    return (await this.query(`select g.id,g.name from mensageria.group_catalog g join mensageria.connection_state s on s.worker_id=g.worker_id where s.id=1 and s.status='connected' and s.lease_until>now() and s.pairing_request_id is not distinct from s.pairing_completed_id order by g.name,g.id`)).rows;
  }
  async groupCatalog() {
    const state=(await this.query('select * from mensageria.connection_state where id=1')).rows[0];
    if (!state || state.status!=='connected' || new Date(state.lease_until || 0).getTime()<=Date.now() || state.pairing_request_id!==state.pairing_completed_id) return {groups:[],catalog:{status:'offline',updated_at:null,error:null}};
    const logs=(await this.query("select id,event,code,created_at from mensageria.connection_logs where worker_id=$1 and event in ('group_catalog_refresh_requested','group_catalog_refresh_started','group_catalog_updated','group_catalog_failed') order by id desc",[state.worker_id])).rows;
    const request=logs.find(r=>r.event==='group_catalog_refresh_requested');
    const started=logs.find(r=>r.event==='group_catalog_refresh_started');
    const finished=logs.find(r=>['group_catalog_updated','group_catalog_failed'].includes(r.event));
    const id=row=>BigInt(row?.id || 0);
    const pending=!finished || id(request)>id(started) || id(started)>id(finished);
    const failed=finished?.event==='group_catalog_failed';
    const error=failed && ['group_lookup_timeout','group_catalog_unavailable','group_catalog_failed'].includes(finished.code) ? finished.code : failed ? 'group_catalog_failed' : null;
    return {groups:await this.groups(),catalog:{status:pending?'pending':failed?'failed':'ready',updated_at:finished?.created_at || null,error:pending?null:error}};
  }
  async requestGroupRefresh() {
    return this.transaction(async tx=>{
      const state=(await tx.query("select worker_id from mensageria.connection_state where id=1 and status='connected' and lease_until>now() and pairing_request_id is not distinct from pairing_completed_id for update")).rows[0];
      if (!state?.worker_id) throw new AppError(409,'group_connection_required');
      const pending=await tx.query("select id from mensageria.connection_logs where worker_id=$1 and event='group_catalog_refresh_requested' and id>coalesce((select max(id) from mensageria.connection_logs where worker_id=$1 and event='group_catalog_refresh_started'),0) limit 1",[state.worker_id]);
      if (!pending.rows.length) await tx.query("insert into mensageria.connection_logs(worker_id,event) values($1,'group_catalog_refresh_requested')",[state.worker_id]);
    });
  }
  async pendingGroupRefresh(worker) {
    const row=(await this.query("select exists(select 1 from mensageria.connection_logs where worker_id=$1 and event='group_catalog_refresh_requested' and id>coalesce((select max(id) from mensageria.connection_logs where worker_id=$1 and event='group_catalog_refresh_started'),0)) as pending",[worker])).rows[0];
    return row.pending;
  }
  async beginGroupSync(worker) {
    const result=await this.query("insert into mensageria.connection_logs(worker_id,event) select $1,'group_catalog_refresh_started' where exists(select 1 from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() and status='connected') returning id",[worker]);
    if (!result.rows.length) throw new Error('worker_lease_lost');
  }
  async syncGroups(worker, groups) {
    return this.transaction(async tx => {
      const lease = await tx.query("select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() and status='connected' for update", [worker]);
      if (!lease.rows.length) throw new Error('worker_lease_lost');
      await tx.query('delete from mensageria.group_catalog');
      for (const group of groups) await tx.query('insert into mensageria.group_catalog(id,name,worker_id) values($1,$2,$3)', [group.id,group.name,worker]);
      await tx.query("insert into mensageria.connection_logs(worker_id,event) values($1,'group_catalog_updated')",[worker]);
    });
  }
  async saveRecipient(r) {
    const group = r.target_type === 'group';
    return this.transaction(async tx => {
      if (group) {
        const allowed = await tx.query(`select g.id from mensageria.group_catalog g join mensageria.connection_state s on s.worker_id=g.worker_id where s.id=1 and s.status='connected' and s.lease_until>now() and s.pairing_request_id is not distinct from s.pairing_completed_id and g.id=$1 for update of s`, [r.group_id]);
        if (!allowed.rows.length) throw new AppError(409, 'group_not_available');
      }
      return (await tx.query(`insert into mensageria.recipients(id,name,phone,target_type,group_id,audience,events,enabled) values($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict(${group ? 'group_id' : 'phone'},audience) do update set name=excluded.name,events=excluded.events,enabled=excluded.enabled,updated_at=now() returning *`,
      [randomUUID(),r.name,r.phone,group ? 'group' : 'phone',r.group_id || null,r.audience,r.events,r.enabled])).rows[0];
    });
  }
  async toggleRecipient(id, enabled) {
    const { rows } = await this.query('update mensageria.recipients set enabled=$2,updated_at=now() where id=$1 returning id', [id, enabled]);
    if (!rows.length) throw new AppError(404, 'recipient_not_found');
  }
  async enqueue(alert) {
    return this.transaction(async tx => {
      const hash = payloadHash(alert);
      const created = await tx.query(`insert into mensageria.ingress(source,idempotency_key,payload_hash) values($1,$2,$3) on conflict do nothing returning source`, [alert.source, alert.idempotency_key, hash]);
      if (!created.rows.length) {
        const old = (await tx.query('select payload_hash from mensageria.ingress where source=$1 and idempotency_key=$2', [alert.source, alert.idempotency_key])).rows[0];
        if (old.payload_hash !== hash) throw new AppError(409, 'idempotency_conflict');
      } else {
        const matches = (await tx.query('select id from mensageria.recipients where enabled and $2=any(events) and ($2=$3 or audience=$1)', [alert.audience, alert.event_type, DELEGATED_EVENT])).rows;
        if (!matches.length) throw new AppError(422, 'no_authorized_recipients');
        for (const r of matches) {
          const id = randomUUID();
          await tx.query(`insert into mensageria.deliveries(id,source,idempotency_key,recipient_id,audience,event_type,title,message) values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, alert.source, alert.idempotency_key, r.id, alert.audience, alert.event_type, alert.title, alert.message]);
          if (alert.water_prompt) await tx.query('update mensageria.deliveries set water_prompt=$2 where id=$1', [id, JSON.stringify(alert.water_prompt)]);
        }
      }
      const jobs = (await tx.query('select id,status from mensageria.deliveries where source=$1 and idempotency_key=$2', [alert.source, alert.idempotency_key])).rows;
      return { duplicate: !created.rows.length, jobs };
    });
  }
  async snapshot() {
    const state = (await this.query('select * from mensageria.connection_state where id=1')).rows[0];
    const deliveries = (await this.query(`select d.id,d.event_type,d.status,d.error_code,d.created_at,d.finished_at,r.name from mensageria.deliveries d join mensageria.recipients r on r.id=d.recipient_id order by d.created_at desc limit 30`)).rows;
    const logs = (await this.query('select event,code,created_at from mensageria.connection_logs order by id desc limit 30')).rows;
    return { state, recipients: await this.recipients(), deliveries, logs };
  }
  async allowLogin(fingerprint) {
    const { rows } = await this.query(`insert into mensageria.login_limits(fingerprint,attempts,expires_at) values($1,1,now()+interval '10 minutes')
      on conflict(fingerprint) do update set attempts=case when mensageria.login_limits.expires_at<now() then 1 else mensageria.login_limits.attempts+1 end,
      expires_at=case when mensageria.login_limits.expires_at<now() then now()+interval '10 minutes' else mensageria.login_limits.expires_at end returning attempts`, [fingerprint]);
    return rows[0].attempts <= 10;
  }
  async lease(worker) {
    return (await this.query(`update mensageria.connection_state set worker_id=$1,lease_until=now()+interval '90 seconds' where id=1 and (lease_until is null or lease_until<now() or worker_id=$1) returning id`, [worker])).rows.length > 0;
  }
  async state(worker, status, name = null, phone = null, qr = null) {
    const result = await this.query(`update mensageria.connection_state set status=$2,account_name=$3,account_phone=$4,qr_encrypted=$5,qr_expires_at=case when $5::bytea is null then null else now()+interval '45 seconds' end,updated_at=now() where id=1 and worker_id=$1 and lease_until>now() returning id`, [worker, status, name, phone, qr]);
    if (!result.rows.length) throw new Error('worker_lease_lost');
  }
  async requestPairingReset() {
    const result = await this.query(`update mensageria.connection_state set pairing_request_id=case when pairing_request_id is distinct from pairing_completed_id then pairing_request_id else $1::uuid end,qr_encrypted=null,qr_expires_at=null,updated_at=now() where id=1 returning pairing_request_id`, [randomUUID()]);
    if (!result.rows.length) throw new Error('connection_state_missing');
    return result.rows[0].pairing_request_id;
  }
  async pendingPairingReset(worker) {
    const result = await this.query('select pairing_request_id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() and pairing_request_id is distinct from pairing_completed_id', [worker]);
    return result.rows[0]?.pairing_request_id || null;
  }
  async completePairingReset(worker, request) {
    return this.transaction(async tx => {
      const lease = await tx.query('select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() and pairing_request_id=$2 for update', [worker, request]);
      if (!lease.rows.length) throw new Error('worker_lease_lost');
      await tx.query("delete from mensageria.session_backups where name='RemoteAuth-mensageria'");
      await tx.query("update mensageria.connection_state set pairing_completed_id=$2,session_saved_at=null,status='connecting',account_name=null,account_phone=null,qr_encrypted=null,qr_expires_at=null,updated_at=now() where id=1 and worker_id=$1", [worker, request]);
      await tx.query("insert into mensageria.connection_logs(worker_id,event) values($1,'pairing_reset_completed')", [worker]);
    });
  }
  async heartbeat(worker) {
    const result = await this.query(`update mensageria.connection_state set lease_until=now()+interval '90 seconds',updated_at=now() where id=1 and worker_id=$1 and lease_until>now() returning id`, [worker]);
    if (!result.rows.length) throw new Error('worker_lease_lost');
  }
  async recipient(id) {
    return (await this.query('select enabled,events,audience,phone,target_type,group_id from mensageria.recipients where id=$1', [id])).rows[0] || null;
  }
  async release(worker) {
    await this.query('update mensageria.connection_state set lease_until=now() where id=1 and worker_id=$1', [worker]);
  }
  async forgetPairedAccount() {
    await this.query(`update mensageria.connection_state set status='connecting',account_name=null,account_phone=null,qr_encrypted=null,qr_expires_at=null,session_saved_at=null,updated_at=now() where id=1`);
  }
  async markSessionSaved(worker) {
    const result = await this.query(`update mensageria.connection_state set session_saved_at=now(),updated_at=now() where id=1 and worker_id=$1 and lease_until>now() returning id`, [worker]);
    if (!result.rows.length) throw new Error('worker_lease_lost');
  }
  async log(worker, event, code = null) { await this.query('insert into mensageria.connection_logs(worker_id,event,code) values($1,$2,$3)', [worker, event, code]); }
  async claim(worker) {
    return this.transaction(async tx => {
      const lease = await tx.query('select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() for update', [worker]);
      if (!lease.rows.length) throw new Error('worker_lease_lost');
      // Nunca reenviar automaticamente trabalhos cujo envio ficou sem confirmacao.
      await tx.query(`update mensageria.deliveries set status='uncertain',error_code='worker_interrupted',message=null,finished_at=now() where status='sending' and worker_id<>$1`, [worker]);
      await tx.query(`update mensageria.deliveries d set status='cancelled',message=null,error_code='recipient_disabled',finished_at=now() where status='pending' and not exists(select 1 from mensageria.recipients r where r.id=d.recipient_id and r.enabled and d.event_type=any(r.events) and (d.event_type=$1 or r.audience=d.audience))`, [DELEGATED_EVENT]);
      const { rows } = await tx.query(`select d.*,r.phone,r.target_type,r.group_id from mensageria.deliveries d join mensageria.recipients r on r.id=d.recipient_id where d.status='pending' and r.enabled and d.event_type=any(r.events) and (d.event_type=$1 or r.audience=d.audience) order by d.created_at limit 1 for update of d skip locked`, [DELEGATED_EVENT]);
      if (!rows.length) return null;
      await tx.query(`update mensageria.deliveries set status='sending',worker_id=$2,started_at=now() where id=$1`, [rows[0].id, worker]);
      return rows[0];
    });
  }
  async finish(worker, id, status, code = null, whatsappId = null) {
    await this.query(`update mensageria.deliveries set status=$3,error_code=$4,whatsapp_id=$5,message=null,finished_at=now() where id=$1 and worker_id=$2 and status='sending'`, [id, worker, status, code, whatsappId]);
  }
  async bindWater(worker, id, address, messageId) {
    const result = await this.query("update mensageria.deliveries set water_address=$3,water_message_id=$4 where id=$1 and worker_id=$2 and status='sending' and water_prompt is not null returning id", [id,worker,address,messageId]);
    if (!result.rows.length) throw new Error('water_binding_failed');
  }
  async waterDelivery(messageId) {
    const row=(await this.query("select * from mensageria.deliveries where water_prompt is not null and (whatsapp_id=$1 or water_message_id=$1) and status in ('sent','sending','uncertain') order by created_at desc limit 1", [messageId])).rows[0];
    return row && !row.superseded_at && (!row.replacement_address || row.status==='sent') ? row : null;
  }
  async beginReplacement(worker,id,address) {
    const result=await this.query("update mensageria.deliveries d set replacement_address=$3 where d.id=$1 and d.worker_id=$2 and d.status='sending' and exists(select 1 from mensageria.recipients r where r.id=d.recipient_id and r.target_type='phone') returning id",[id,worker,address]);
    if(!result.rows.length) throw new Error('replacement_tracking_failed');
  }
  async completeReplacement(worker,id,address,ids) {
    return this.transaction(async tx=>{
      const lease=await tx.query('select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() for update',[worker]);
      if(!lease.rows.length) throw new Error('worker_lease_lost');
      const row=(await tx.query("update mensageria.deliveries set status='sent',error_code=null,whatsapp_id=$4,message=null,finished_at=now(),replacement_message_ids=$5 where id=$1 and worker_id=$2 and status='sending' and replacement_address=$3 returning audience,event_type,recipient_id",[id,worker,address,ids.at(-1),JSON.stringify(ids)])).rows[0];
      if(!row) throw new Error('replacement_completion_failed');
      const tracked=(await tx.query("select id from mensageria.deliveries where id<>$1 and status='sent' and replacement_address=$2 and audience=$3 and event_type=$4 and jsonb_array_length(replacement_message_ids)>0 limit 1",[id,address,row.audience,row.event_type])).rows;
      if(!tracked.length) {
        const legacy=(await tx.query("select id,whatsapp_id,water_message_id,replacement_message_ids from mensageria.deliveries where id<>$1 and status='sent' and replacement_address is null and recipient_id=$2 and audience=$3 and event_type=$4 order by finished_at desc nulls last,created_at desc limit 1 for update",[id,row.recipient_id,row.audience,row.event_type])).rows[0];
        const known=[...new Set([legacy?.water_message_id,legacy?.whatsapp_id,...(legacy?.replacement_message_ids || [])].filter(value=>typeof value==='string' && value))];
        if(known.length)await tx.query('update mensageria.deliveries set replacement_address=$2,replacement_message_ids=$3 where id=$1',[legacy.id,address,JSON.stringify(known)]);
      }
      await tx.query("update mensageria.deliveries set superseded_at=now(),delete_pending_ids=replacement_message_ids,delete_attempts=0,delete_next_at=now(),delete_error=null where id<>$1 and status='sent' and superseded_at is null and replacement_address=$2 and audience=$3 and event_type=$4 and jsonb_array_length(replacement_message_ids)>0",[id,address,row.audience,row.event_type]);
    });
  }
  async appendReplacementMessage(worker,id,messageId,address=null,audience=null) {
    const result=await this.query("update mensageria.deliveries d set replacement_message_ids=replacement_message_ids || $3::jsonb where d.id=$1 and d.status='sent' and d.superseded_at is null and ($5::text is null or d.audience=$5) and ((d.replacement_address is not null and ($4::text is null or d.replacement_address=$4)) or (d.replacement_address is null and $4::text is not null and d.water_address=$4)) and exists(select 1 from mensageria.recipients r where r.id=d.recipient_id and r.target_type='phone') and exists(select 1 from mensageria.connection_state where id=1 and worker_id=$2 and lease_until>now()) returning id",[id,worker,JSON.stringify([messageId]),address,audience]);
    if(!result.rows.length) throw new Error('replacement_feedback_tracking_failed');
  }
  async pendingReplacementDeletes() {
    return (await this.query("select id,replacement_address,audience,event_type,delete_pending_ids from mensageria.deliveries where status='sent' and superseded_at is not null and delete_next_at<=now() and delete_attempts<6 and jsonb_array_length(delete_pending_ids)>0 order by delete_next_at limit 5")).rows;
  }
  async settleReplacementDelete(worker,id,messageId,code=null,terminal=false) {
    return this.transaction(async tx=>{
      const lease=await tx.query('select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() for update',[worker]);
      if(!lease.rows.length) throw new Error('worker_lease_lost');
      const row=(await tx.query('select delete_pending_ids,delete_attempts,delete_error from mensageria.deliveries where id=$1 and superseded_at is not null for update',[id])).rows[0];
      if(!row || !row.delete_pending_ids.includes(messageId))return;
      const pending=code && !terminal ? row.delete_pending_ids : row.delete_pending_ids.filter(item=>item!==messageId);
      const attempts=Number(row.delete_attempts)+(code && !terminal?1:0);
      const next=pending.length && attempts<6 ? new Date(Date.now()+(code && !terminal?Math.min(1800000,30000*2**attempts):0)).toISOString():null;
      await tx.query('update mensageria.deliveries set delete_pending_ids=$2,delete_attempts=$3,delete_next_at=$4,delete_error=$5 where id=$1',[id,JSON.stringify(pending),attempts,next,code || row.delete_error || null]);
    });
  }
  async cleanup() {
    await this.query("delete from mensageria.connection_logs where created_at<now()-interval '30 days'");
    await this.query("delete from mensageria.login_limits where expires_at<now()");
    await this.query("update mensageria.deliveries set message=null,status='cancelled',error_code='expired',finished_at=now() where status='pending' and created_at<now()-interval '24 hours'");
    await this.query("delete from mensageria.deliveries where created_at<now()-interval '30 days' and status not in ('pending','sending')");
    await this.query("delete from mensageria.ingress i where created_at<now()-interval '30 days' and not exists(select 1 from mensageria.deliveries d where d.source=i.source and d.idempotency_key=i.idempotency_key)");
  }
  async purchaseState() {
    return (await this.query('select data from mensageria.purchase_state where id=1')).rows[0]?.data || {};
  }
  async changePurchaseState(worker,change) {
    return this.transaction(async tx=>{
      const lease=await tx.query('select id from mensageria.connection_state where id=1 and worker_id=$1 and lease_until>now() for update',[worker]);
      if(!lease.rows.length)throw new Error('worker_lease_lost');
      const data=(await tx.query('select data from mensageria.purchase_state where id=1 for update')).rows[0]?.data || {};
      const result=await change(data);
      const encoded=JSON.stringify(data);
      if(Buffer.byteLength(encoded)>524288)throw new Error('purchase_state_limit');
      await tx.query('update mensageria.purchase_state set data=$1,updated_at=now() where id=1',[encoded]);
      return result;
    });
  }
  async knownBotMessage(id) {
    return (await this.query('select id from mensageria.deliveries where whatsapp_id=$1 or water_message_id=$1 or replacement_message_ids @> $2::jsonb limit 1',[id,JSON.stringify([id])])).rows.length>0;
  }
}
