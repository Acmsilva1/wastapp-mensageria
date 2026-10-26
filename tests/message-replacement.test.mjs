import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Repository} from '../lib/repository.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {alertInput,recipientInput} from '../lib/domain.mjs';
import {createMessageReplacement,revokeOwnMessageInPage,revokeBotMessage} from '../worker/message-replacement.mjs';
import {createWaterReplies,brazilDate} from '../worker/water-replies.mjs';

async function fixture(mode) {
 let db,dir,repo;
 if(mode==='sql') {
  db=new PGlite();for(const f of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','004_water_replies.sql','005_message_replacement.sql','007_interaction_permissions.sql'])await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
 }else{dir=await mkdtemp(path.join(os.tmpdir(),'replace-'));repo=await VolumeRepository.open(dir);}
 const worker=randomUUID();await repo.lease(worker);let count=0;
 const phone='+5511900000000',address='5511900000000@c.us';
 const allEvents=['health.water_progress','health.diet_menu','financeiro.daily_summary'];
 const row=async id=>mode==='sql'?(await db.query('select * from mensageria.deliveries where id=$1',[id])).rows[0]:(await repo.read()).deliveries.find(r=>r.id===id);
 async function job({event_type='health.water_progress',audience='1',number=phone,group=false,water=true}={}) {
  if(group){await repo.state(worker,'connected');await repo.syncGroups(worker,[{id:number,name:'Grupo'}]);}
  await repo.saveRecipient(recipientInput({name:'Teste',audience,events:allEvents,permissions:group?[]:['water.record'],...(group?{target_type:'group',group_id:number}:{phone:number})}));
  const key=`agua:${brazilDate()}:10:${String(++count).padStart(2,'0')}:${audience}`;
  const event=alertInput({source:'superapp',audience,event_type,idempotency_key:key,title:'Aviso',message:'Ficticio',...(event_type==='health.water_progress' && water?{water_prompt:{profile_id:audience,date:brazilDate(),dedupe_key:key,signature:'a'.repeat(64)}}:{})});
  await repo.enqueue(event);
  let selected,next;
  while((next=await repo.claim(worker))) {
    if(!selected && next.audience===audience && (group?next.group_id===number:next.phone===number))selected=next;
    else await repo.finish(worker,next.id,'cancelled','fixture_other_recipient');
  }
  assert.ok(selected);return selected;
 }
 const forceRetry=async id=>mode==='sql'?db.query("update mensageria.deliveries set delete_next_at=now()-interval '1 second' where id=$1",[id]):repo.mutate(data=>{data.deliveries.find(r=>r.id===id).delete_next_at=new Date(0).toISOString();});
 return {repo,worker,row,job,phone,address,forceRetry,exec:sql=>db.exec(sql),close:async()=>{if(db)await db.close();if(dir)await rm(dir,{recursive:true,force:true});}};
}
for(const mode of ['sql','volume']) {
test(`${mode}: substitui conjunto completo, falha parcial preserva anterior, terminal por ID e restart`,async()=>{
 const f=await fixture(mode);let repo=f.repo;const deleted=[];
 try{
 const replacements=createMessageReplacement({repo,worker:f.worker,revoke:async(_address,id)=>{deleted.push(id);return id==='old-text'?{ok:false,code:'delete_not_revocable',terminal:true}:{ok:true};}});
 const old=await f.job();await replacements.begin(old,f.address);await repo.bindWater(f.worker,old.id,f.address,'old-text');await replacements.complete(old,f.address,['old-text','old-poll'],2);
 await repo.appendReplacementMessage(f.worker,old.id,'old-confirmation');
 const partial=await f.job();await replacements.begin(partial,f.address);await repo.bindWater(f.worker,partial.id,f.address,'partial-text');
 await assert.rejects(replacements.complete(partial,f.address,['partial-text'],2),/replacement_ids_missing/);
 await repo.finish(f.worker,partial.id,'uncertain','send_unconfirmed');
 assert.equal((await f.row(old.id)).superseded_at || null,null);assert.ok(await repo.waterDelivery('old-poll'));assert.equal(await repo.waterDelivery('partial-text'),null);
 const fresh=await f.job();await replacements.begin(fresh,f.address);await repo.bindWater(f.worker,fresh.id,f.address,'new-text');await replacements.complete(fresh,f.address,['new-text','new-poll'],2);
 assert.equal(await repo.waterDelivery('old-poll'),null);assert.ok(await repo.waterDelivery('new-poll'));assert.equal((await f.row(fresh.id)).status,'sent');
 // Re-open volume / construct another SQL repository to prove the queue lives in storage.
 if(mode==='volume')repo=await VolumeRepository.open(repo.dataPath);else repo=new Repository(f.repo.pool);
 const resumed=createMessageReplacement({repo,worker:f.worker,revoke:async(_address,id)=>{deleted.push(id);return id==='old-text'?{ok:false,code:'delete_not_revocable',terminal:true}:{ok:true};}});
 await resumed.cleanup();assert.deepEqual(deleted,['old-text','old-poll','old-confirmation']);
 const previous=await f.row(old.id);assert.deepEqual(previous.delete_pending_ids,[]);assert.equal(previous.delete_error,'delete_not_revocable');assert.equal((await f.row(fresh.id)).status,'sent');assert.equal((await f.row(partial.id)).status,'uncertain');
 }finally{await f.close();}
});
test(`${mode}: isola tipos, pessoas, perfis e grupos; legado somente ultimo sent seguro`,async()=>{
 const f=await fixture(mode);try{
 const deleted=[];const r=createMessageReplacement({repo:f.repo,worker:f.worker,revoke:async(_a,id)=>{deleted.push(id);return {ok:true};}});
 const legacy=await f.job({event_type:'health.diet_menu'});await f.repo.finish(f.worker,legacy.id,'sent',null,'legacy-known');
 const uncertain=await f.job({event_type:'health.diet_menu'});await f.repo.finish(f.worker,uncertain.id,'uncertain','send_unconfirmed','uncertain-never');
 const variants=[{event_type:'health.water_progress'},{event_type:'financeiro.daily_summary'},{event_type:'health.diet_menu',audience:'2'},{event_type:'health.diet_menu',number:'+5511999999999'}];
 // Enqueue each variant in isolation: financeiro deliberately fans out across enabled recipients.
 for(const v of variants){const j=await f.job(v);await r.begin(j,j.phone.slice(1)+'@c.us');await r.complete(j,j.phone.slice(1)+'@c.us',['isolated-'+j.id]);while(await f.repo.claim(f.worker)){/* only extra financial copies, never sent or tracked */}}
 const latest=await f.job({event_type:'health.diet_menu'});await r.begin(latest,f.address);await r.complete(latest,f.address,['latest']);await r.cleanup();
 assert.deepEqual(deleted,['legacy-known']);assert.equal((await f.row(uncertain.id)).superseded_at || null,null);
 assert.equal((await f.row(legacy.id)).status,'sent');
 const group='120363123456789@g.us';const gj=await f.job({number:group,group:true,event_type:'health.water_progress'});
 // A phone copy may precede the group; finish copies until the group is claimed.
 let actual=gj;while(actual && actual.target_type!=='group'){await f.repo.finish(f.worker,actual.id,'sent',null,'group-copy');actual=await f.repo.claim(f.worker);}
 assert.ok(actual);await r.begin(actual,group);await r.complete(actual,group,['group-id']);assert.equal((await f.row(actual.id)).replacement_address || null,null);
 const secondGroup=await f.job({number:group,group:true,event_type:'health.water_progress'});await r.begin(secondGroup,group);await r.complete(secondGroup,group,['group-id-2']);await r.cleanup();
 assert.equal((await f.row(actual.id)).superseded_at || null,null);assert.deepEqual(deleted,['legacy-known']);
 }finally{await f.close();}
});
test(`${mode}: exclusao transiente tem backoff limitado sem reenviar ou mudar status`,async()=>{
 const f=await fixture(mode);try{
 let calls=0;const r=createMessageReplacement({repo:f.repo,worker:f.worker,revoke:async()=>{calls++;return {ok:false,code:'delete_timeout',terminal:false};}});
 const old=await f.job({event_type:'health.diet_menu'});await r.begin(old,f.address);await r.complete(old,f.address,['old']);
 const fresh=await f.job({event_type:'health.diet_menu'});await r.begin(fresh,f.address);await r.complete(fresh,f.address,['fresh']);
 await r.cleanup();assert.equal(calls,1);await r.cleanup();assert.equal(calls,1,'backoff impede retry imediato');
 for(let n=1;n<6;n++){await f.forceRetry(old.id);await r.cleanup();}
 assert.equal(calls,6);assert.equal((await f.row(old.id)).delete_next_at,null);await r.cleanup();assert.equal(calls,6);
 assert.equal((await f.row(fresh.id)).status,'sent');assert.deepEqual((await f.row(old.id)).delete_pending_ids,['old']);
 }finally{await f.close();}
});
test(`${mode}: lock compartilhado impede resposta antiga apos substituicao e acompanha feedback`,async()=>{
 const f=await fixture(mode);try{
 const r=createMessageReplacement({repo:f.repo,worker:f.worker,revoke:async()=>({ok:true})});
 const old=await f.job();await r.begin(old,f.address);await f.repo.bindWater(f.worker,old.id,f.address,'oldtext');await r.complete(old,f.address,['oldtext','oldpoll'],2);
 let requests=0,sends=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const client={info:{wid:{user:'5511888888888'}}};
 const h=createWaterReplies({client,repo:f.repo,worker:f.worker,replacements:r,request:async()=>{requests++;return {duplicate:false,profile_name:'Pessoa',amount_ml:200,realizado_ml:200,meta_ml:2000,remaining_ml:1800};},send:async()=>({id:{_serialized:'feedback-'+(++sends)}})});
 const vote={voter:f.address,parentMessage:{id:{_serialized:'oldpoll'},to:f.address},selectedOptions:[{localId:1,name:'200 ml'}]};
 await h.vote(vote);assert.equal(requests,1);assert.ok((await f.row(old.id)).replacement_message_ids.includes('feedback-1'));
 const fresh=await f.job();
 const replacing=r.withScope(fresh,f.address,async()=>{await gate;await r.begin(fresh,f.address);await f.repo.bindWater(f.worker,fresh.id,f.address,'freshtext');await r.complete(fresh,f.address,['freshtext','freshpoll'],2);});
 const stale=h.vote(vote);await new Promise(resolve=>setImmediate(resolve));release();await replacing;await stale;
 assert.equal(requests,1);assert.equal(sends,1,'nenhum callback/confirmacao antigo depois da troca');
 const errors=createWaterReplies({client,repo:f.repo,worker:f.worker,replacements:r,request:async()=>{throw Object.assign(new Error('water_goal_required'),{retryable:false});},send:async()=>({id:{$1:'failure-feedback'}})});
 await errors.vote({...vote,parentMessage:{id:{$1:'freshpoll'},to:f.address}});assert.ok((await f.row(fresh.id)).replacement_message_ids.includes('failure-feedback'));
 }finally{await f.close();}
});
test(`${mode}: feedback novo de legado e guardado sem mudar selecao do ultimo aviso`,async()=>{
 const f=await fixture(mode);try{
 const removed=[];const r=createMessageReplacement({repo:f.repo,worker:f.worker,revoke:async(_address,id)=>{removed.push(id);return {ok:true};}});
 const legacy=await f.job();await f.repo.bindWater(f.worker,legacy.id,f.address,'legacy-text');await f.repo.finish(f.worker,legacy.id,'sent',null,'legacy-poll');
 const h=createWaterReplies({client:{info:{wid:{user:'5511888888888'}}},repo:f.repo,worker:f.worker,replacements:r,
  request:async()=>({duplicate:false,profile_name:'Pessoa',amount_ml:200,realizado_ml:200,meta_ml:2000,remaining_ml:1800}),send:async()=>({id:{$1:'legacy-feedback'}})});
 await h.vote({voter:f.address,parentMessage:{id:{$1:'legacy-poll'},to:f.address},selectedOptions:[{localId:1,name:'200 ml'}]});
 let row=await f.row(legacy.id);assert.equal(row.replacement_address || null,null);assert.deepEqual(row.replacement_message_ids,['legacy-feedback']);
 await assert.rejects(f.repo.appendReplacementMessage(f.worker,legacy.id,'wrong-chat','5511999999999@c.us','1'),/replacement_feedback_tracking_failed/);
 await assert.rejects(f.repo.appendReplacementMessage(f.worker,legacy.id,'wrong-profile',f.address,'2'),/replacement_feedback_tracking_failed/);
 assert.deepEqual((await f.row(legacy.id)).replacement_message_ids,['legacy-feedback']);
 const fresh=await f.job();await r.begin(fresh,f.address);await f.repo.bindWater(f.worker,fresh.id,f.address,'fresh-text');await r.complete(fresh,f.address,['fresh-text','fresh-poll'],2);await r.cleanup();
 assert.deepEqual(removed,['legacy-text','legacy-poll','legacy-feedback']);row=await f.row(legacy.id);assert.deepEqual(row.delete_pending_ids,[]);assert.equal(row.status,'sent');
 }finally{await f.close();}
});
}

test('migration005 idempotente; rollback protege pendencias e conserva historico ao reverter sem ativos',async()=>{
 const f=await fixture('sql');try{
 const migration=await readFile(new URL('../migrations/005_message_replacement.sql',import.meta.url),'utf8');
 const rollback=await readFile(new URL('../migrations/005_message_replacement_rollback.sql',import.meta.url),'utf8');
 await f.exec(migration);
 const r=createMessageReplacement({repo:f.repo,worker:f.worker,revoke:async()=>({ok:true})});
 const old=await f.job({event_type:'health.diet_menu'});await r.begin(old,f.address);await r.complete(old,f.address,['old']);
 const fresh=await f.job({event_type:'health.diet_menu'});await r.begin(fresh,f.address);await r.complete(fresh,f.address,['fresh']);
 await assert.rejects(f.exec(rollback),/Exporte e resolva/);await f.exec('rollback');
 assert.equal((await f.row(old.id)).status,'sent');assert.equal((await f.row(fresh.id)).status,'sent');
 await r.cleanup();await f.exec("update mensageria.deliveries set created_at=now()-interval '3 days'");
 await f.exec(rollback);
 const preserved=await f.repo.query('select id,status from mensageria.deliveries');assert.equal(preserved.rows.length,2);assert.ok(preserved.rows.every(row=>row.status==='sent'));
 }finally{await f.close();}
});

test('revogacao exige bot, conversa e permissao; nunca cai em exclusao local',async()=>{
 const prior=globalThis.window;let revoked=0,local=0,allowed=false;
 const address='5511900000000@c.us';const message={id:{fromMe:true,_serialized:'bot-id',remote:{_serialized:address}},type:'chat'};const chat={id:{_serialized:address}};
 try{
 globalThis.window={Debug:{VERSION:'2.3000.1'},WWebJS:{compareWwebVersions:()=>true},require:name=>({
 WAWebCollections:{Msg:{get:()=>message,getMessagesById:async()=>({messages:[]})},Chat:{get:()=>chat}},
 WAWebMsgActionCapability:{canSenderRevokeMsg:()=>allowed},WAWebCmd:{Cmd:{sendRevokeMsgs:async()=>{revoked++;},sendDeleteMsgs:async()=>{local++;}}}
 })[name]};
 assert.equal((await revokeOwnMessageInPage('bot-id',address)).code,'delete_not_revocable');assert.equal(local,0);assert.equal(revoked,0);
 allowed=true;assert.equal((await revokeOwnMessageInPage('bot-id',address)).ok,true);assert.equal(revoked,1);assert.equal(local,0);
 message.id.fromMe=false;assert.equal((await revokeOwnMessageInPage('bot-id',address)).code,'delete_not_bot_message');assert.equal(revoked,1);
 message.id.fromMe=true;assert.equal((await revokeOwnMessageInPage('bot-id','5511999999999@c.us')).code,'delete_wrong_conversation');assert.equal(revoked,1);
 const adapter=await revokeBotMessage({getMessageById:async()=>({fromMe:false,id:{_serialized:'user-id'}}),pupPage:{evaluate:()=>{throw new Error('must not call');}}},address,'user-id');assert.equal(adapter.code,'delete_not_bot_message');
 }finally{if(prior===undefined)delete globalThis.window;else globalThis.window=prior;}
});

test('limpeza local e exclusiva da propria conversa PN/LID com autoria, destino e ID exatos',async()=>{
 const prior=globalThis.window;let local=0,revoked=0,remote='5511888888888@c.us',fromMe=true;
 const mePn='5511888888888@c.us',meLid='123456789@lid';
 const message={id:{fromMe:true,$1:'own-bot-id',remote:{$1:remote}},type:'chat'};
 try{
 globalThis.window={Debug:{VERSION:'2.3000.1'},WWebJS:{compareWwebVersions:()=>true},require:name=>({
  WAWebCollections:{Msg:{get:()=>{message.id.fromMe=fromMe;message.id.remote={$1:remote};return message;},getMessagesById:async()=>({messages:[]})},Chat:{get:()=>({id:{$1:remote}})}},
  WAWebUserPrefsMeUser:{getMaybeMePnUser:()=>({$1:mePn}),getMaybeMeLidUser:()=>({$1:meLid})},
  WAWebMsgActionCapability:{canSenderRevokeMsg:()=>false},
  WAWebCmd:{Cmd:{sendDeleteMsgs:async(chat,payload,clear)=>{assert.equal(chat.id.$1,remote);assert.deepEqual(payload,{list:[message],type:'message'});assert.equal(clear,true);local++;},sendRevokeMsgs:async()=>{revoked++;}}}
 })[name]};
 assert.deepEqual(await revokeOwnMessageInPage('own-bot-id',mePn),{ok:true,mode:'self'});assert.equal(local,1);
 remote=meLid;assert.deepEqual(await revokeOwnMessageInPage('own-bot-id',meLid),{ok:true,mode:'self'});assert.equal(local,2);
 for(const stranger of ['5511900000000@c.us','987654321@lid']) {
  remote=stranger;assert.equal((await revokeOwnMessageInPage('own-bot-id',stranger)).code,'delete_not_revocable');assert.equal(local,2);
 }
 assert.equal((await revokeOwnMessageInPage('own-bot-id',mePn)).code,'delete_wrong_conversation');assert.equal(local,2,'endereco fornecido nao pode transformar conversa alheia em self');
 remote=mePn;fromMe=false;assert.equal((await revokeOwnMessageInPage('own-bot-id',mePn)).code,'delete_not_bot_message');assert.equal(local,2);
 fromMe=true;assert.equal((await revokeOwnMessageInPage('different-id',mePn)).code,'delete_not_bot_message');assert.equal(local,2);assert.equal(revoked,0);
 }finally{if(prior===undefined)delete globalThis.window;else globalThis.window=prior;}
});
