import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Repository} from '../lib/repository.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {alertInput,recipientInput} from '../lib/domain.mjs';
import {brazilDate,parseWaterAmount,createWaterReplies,requestWater,callbackConfig,WATER_OPTIONS,chatAddressFromSerialized,sameConversation,voteChatAddress} from '../worker/water-replies.mjs';
const token='water-contract-token-32-characters-test';
function alert(date=brazilDate()) {
 const profile_id='1',dedupe_key=`agua:${date}:10:00:1`;
 const water_prompt={profile_id,date,dedupe_key,signature:createHmac('sha256',token).update(JSON.stringify([profile_id,date,dedupe_key])).digest('hex')};
 return alertInput({source:'superapp',audience:'1',event_type:'health.water_progress',idempotency_key:dedupe_key,title:'Agua',message:'Hoje 200/2000 ml',water_prompt});
}
test('contrato assinado preserva o payload do produtor e rejeita cruzamento de perfil/evento',()=>{
 const valid=alert(); assert.equal(valid.water_prompt.profile_id,'1');
 for(const changes of [{audience:'2'},{source:'jarvis'},{event_type:'health.diet_menu'},{water_prompt:{...valid.water_prompt,signature:'bad'}}]) assert.throws(()=>alertInput({...valid,...changes}));
 assert.equal(parseWaterAmount('200 ml'),200);assert.equal(parseWaterAmount('1 L'),1000);assert.equal(parseWaterAmount('2 litros'),2000);assert.equal(parseWaterAmount('600'),null);
 assert.equal(brazilDate(new Date('2026-10-25T01:00:00Z')),'2026-10-24');
 assert.deepEqual(WATER_OPTIONS,['100 ml','200 ml','300 ml','400 ml','500 ml','1 L','2 L']);
 assert.equal(chatAddressFromSerialized('true_214082795909181@lid_3EB0BB793CBD1B55815517'),'214082795909181@lid');
 assert.equal(chatAddressFromSerialized('true_5527988516301@c.us_3EB0ABC'),'5527988516301@c.us');
 assert.equal(voteChatAddress({parentMessage:{id:{$1:'true_214@lid_3EB0'},to:undefined},parentMsgKey:'true_214@lid_3EB0'}),'214@lid');
});
test('mesma conversa aceita par PN/@lid resolvido pelo mapeamento oficial',async()=>{
 const pn='5511900000000@c.us',lid='214082795909181@lid';
 const client={getContactLidAndPhone:async(ids)=>ids.map(id=>id.endsWith('@lid')?{lid:id,pn}:{lid,pn:id})};
 assert.equal(await sameConversation(client,pn,pn),true);
 assert.equal(await sameConversation(client,pn,lid),true);
 assert.equal(await sameConversation(client,lid,pn),true);
 assert.equal(await sameConversation(client,pn,'5511999999999@c.us'),false);
});
test('callback usa HTTPS, segredo separado, caminho e corpo acordados; resposta validada',async()=>{
 const env={SUPERAPP_API_ORIGIN:'https://super.example/path',WHATSAPP_WATER_CALLBACK_TOKEN:token};
 assert.equal(callbackConfig({...env,SUPERAPP_API_ORIGIN:'http://super.example'}),null);
 let calls=0;
 const result={ok:true,duplicate:false,profile_name:'Pessoa',amount_ml:200,realizado_ml:400,meta_ml:2000,remaining_ml:1600};
 assert.deepEqual(await requestWater(alert().water_prompt,200,{env,fetcher:async(url,options)=>{
 calls++;assert.equal(url,'https://super.example/api/saude?resource=whatsapp-water');assert.equal(options.headers.Authorization,`Bearer ${token}`);
 assert.deepEqual(JSON.parse(options.body),{water_prompt:alert().water_prompt,amount_ml:200});return {ok:true,json:async()=>result};}}),result);
 assert.equal(calls,1);
 await assert.rejects(requestWater(alert().water_prompt,200,{env,fetcher:async()=>({ok:false,status:409})}),/water_already_recorded/);
 await assert.rejects(requestWater(alert().water_prompt,200,{env,fetcher:async()=>({ok:false,status:409,json:async()=>({error:'water_goal_required'})})}),/water_goal_required/);
 await assert.rejects(requestWater(alert().water_prompt,200,{env,fetcher:async()=>({ok:true,json:async()=>({...result,remaining_ml:0})})}),/water_invalid_response/);
});
for(const mode of ['sql','volume']) test(`${mode}: persistencia, restart, voto, resposta, isolamento, falha e deduplicacao`,async()=>{
 let repo,db,dir;
 if(mode==='sql') {
   db=new PGlite();for(const name of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','004_water_replies.sql','005_message_replacement.sql','007_interaction_permissions.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
   repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
 } else {dir=await mkdtemp(path.join(os.tmpdir(),'water-replies-'));repo=await VolumeRepository.open(dir);}
 try {
 const phone='+5511900000000',worker=randomUUID();
 const r=await repo.saveRecipient(recipientInput({name:'Pessoa',phone,audience:'1',permissions:['water.record'],events:['health.water_progress']}));
 await repo.lease(worker);const a=alert();await repo.enqueue(a);
 const job=await repo.claim(worker);await repo.bindWater(worker,job.id,'5511900000000@c.us','reminder-id');await repo.finish(worker,job.id,'sent',null,'poll-id');
 if(mode==='volume') repo=await VolumeRepository.open(dir);
 assert.deepEqual((await repo.waterDelivery('poll-id')).water_prompt,a.water_prompt);
 assert.equal((await repo.waterDelivery('reminder-id')).id,job.id);
 const sent=[],requests=[];let failed=false;
 const client={info:{wid:{user:'5511888888888',_serialized:'5511888888888@c.us'}},getContactLidAndPhone:async(ids)=>(ids||[]).flatMap(id=>id==='123@lid'||id==='5511900000000@c.us'?[{lid:'123@lid',pn:'5511900000000@c.us'}]:[])};
 const handlers=createWaterReplies({client,repo,worker,send:async(address,text)=>sent.push({address,text}),request:async(p,amount)=>{
  requests.push({p,amount});if(failed) throw new Error('network_failure');
  return {ok:true,duplicate:requests.length>1,profile_name:'Pessoa',amount_ml:amount,realizado_ml:400,meta_ml:2000,remaining_ml:1600};
 }});
 const vote=(changes={})=>({voter:{$1:'5511900000000@c.us'},parentMessage:{id:{$1:'poll-id'},to:{$1:'5511900000000@c.us'}},selectedOptions:[{localId:1,name:'200 ml'}],...changes});
 await handlers.vote(vote());assert.equal(requests.length,1);assert.match(sent[0].text,/Registro realizado: 200 ml/);assert.match(sent[0].text,/Faltam 1600 ml/);
 await handlers.vote(vote());assert.match(sent[1].text,/já foi registrado/);
 await handlers.vote(vote({voter:'5511999999999@c.us'}));assert.equal(requests.length,2);
 await handlers.vote(vote({selectedOptions:[]}));assert.equal(requests.length,2);
 await handlers.vote(vote({parentMessage:{id:{_serialized:'forged'},to:'5511900000000@c.us'}}));assert.equal(requests.length,2);
 await handlers.vote(vote({parentMessage:{id:{_serialized:'poll-id'},to:'5511999999999@c.us'}}));assert.equal(requests.length,2);
 await handlers.vote(vote({voter:'123@lid'}));assert.equal(requests.length,3);
 client.getContactLidAndPhone=async(ids)=>ids.flatMap(id=>id==='214@lid'||id==='5511900000000@c.us'?[{lid:'214@lid',pn:'5511900000000@c.us'}]:id==='123@lid'?[{lid:'123@lid',pn:'5511900000000@c.us'}]:[]);
 await handlers.vote(vote({voter:'5511900000000@c.us',parentMessage:{id:{$1:'poll-id'},to:undefined},parentMsgKey:'true_214@lid_poll-id'}));
 assert.equal(requests.length,4,'voto com remote @lid casa com water_address @c.us');
 // Reconciliacao recupera voto ja presente no WhatsApp quando vote_update falha.
 const pollVotes=[{voter:'5511900000000@c.us',parentMessage:{id:{$1:'poll-id'},to:'214@lid'},selectedOptions:[{localId:2,name:'300 ml'}]}];
 const reconciling=createWaterReplies({client,repo,worker,send:async(address,text)=>sent.push({address,text}),request:async(p,amount)=>{requests.push({p,amount});return {ok:true,duplicate:false,profile_name:'Pessoa',amount_ml:amount,realizado_ml:700,meta_ml:2000,remaining_ml:1300};},getPollVotes:async id=>{assert.equal(id,'poll-id');return pollVotes;}});
 assert.equal(typeof repo.openWaterPolls,'function');
 assert.equal((await repo.openWaterPolls(brazilDate()))[0]?.whatsapp_id,'poll-id');
 await reconciling.reconcile();assert.equal(requests.length,5);assert.match(sent.at(-1).text,/300 ml/);
 failed=true;await handlers.message({type:'chat',hasQuotedMsg:true,from:'5511900000000@c.us',body:'200 ml',getQuotedMessage:async()=>({fromMe:true,id:{$1:'reminder-id'}})});
 assert.equal(requests.length,7);assert.match(sent.at(-1).text,/Não foi possível confirmar/);assert.doesNotMatch(sent.at(-1).text,/Registro realizado/);
 await repo.toggleRecipient(r.id,false);await handlers.vote(vote());assert.equal(requests.length,7);
 const old=alert('2020-01-01');await repo.toggleRecipient(r.id,true);await repo.enqueue(old);const oldJob=await repo.claim(worker);await repo.bindWater(worker,oldJob.id,'5511900000000@c.us','old-text');await repo.finish(worker,oldJob.id,'sent',null,'old-poll');
 await handlers.vote(vote({parentMessage:{id:{_serialized:'old-poll'},to:'5511900000000@c.us'}}));assert.equal(requests.length,7);
 const groupId='120363123456789@g.us';await repo.state(worker,'connected');await repo.syncGroups(worker,[{id:groupId,name:'Grupo'}]);
 const group=await repo.saveRecipient(recipientInput({target_type:'group',group_id:groupId,name:'Grupo',audience:'1',events:['health.water_progress']}));
 const ga=alertInput({...a,idempotency_key:a.idempotency_key.replace(':10:00:',':11:00:'),water_prompt:{...a.water_prompt,dedupe_key:a.idempotency_key.replace(':10:00:',':11:00:')}});
 await repo.enqueue(ga);let gj;
 for(let n=0;n<2;n++){const next=await repo.claim(worker);if(next.target_type==='group'){gj=next;await repo.bindWater(worker,next.id,groupId,'group-text');await repo.finish(worker,next.id,'sent',null,'group-poll');}else await repo.finish(worker,next.id,'sent',null,'individual-other');}
 assert.ok(gj);const gv=vote({parentMessage:{id:{_serialized:'group-poll'},to:groupId}});
 failed=false;await handlers.vote(gv);assert.equal(requests.length,8);
 await handlers.vote({...gv,voter:'5511999999999@c.us'});assert.equal(requests.length,8);
 await repo.toggleRecipient(r.id,false);await handlers.vote(gv);assert.equal(requests.length,8);
 await repo.toggleRecipient(r.id,true);await repo.toggleRecipient(group.id,false);await handlers.vote(gv);assert.equal(requests.length,8);
 client.info.wid={user:'123',_serialized:'123@lid'};
 await handlers.message({type:'chat',hasQuotedMsg:true,fromMe:true,to:'5511900000000@c.us',body:'200 ml',getQuotedMessage:async()=>({fromMe:true,id:{$1:'reminder-id'}})});
 assert.equal(requests.length,9,'connected LID resolves to authorized phone for self reply');
 await repo.saveRecipient(recipientInput({name:'Pessoa',phone,audience:'1',events:['health.water_progress'],permissions:[]}));
 await handlers.vote(vote());assert.equal(requests.length,10,'the single water switch authorizes recording');
 await repo.saveRecipient(recipientInput({name:'Pessoa',phone,audience:'1',events:['health.diet_menu'],permissions:['water.record']}));
 await handlers.vote(vote());assert.equal(requests.length,10,'turning water off revokes replies even with a legacy flag');
 } finally {if(db) await db.close();if(dir) await rm(dir,{recursive:true,force:true});}
});
