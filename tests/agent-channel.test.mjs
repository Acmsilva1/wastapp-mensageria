import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AgentInbox} from '../lib/agent-inbox.mjs';
import {createAgentService} from '../lib/agent-channel.mjs';
import {createAgentChannel} from '../worker/agent-channel.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {createHandler} from '../lib/http-handler.mjs';
import {recipientInput,alertInput,interactionVersion} from '../lib/domain.mjs';
import {replacementScope} from '../worker/message-replacement.mjs';
import {createWhatsAppPurchases} from '../worker/whatsapp-purchases.mjs';
import {createWaterReplies,brazilDate} from '../worker/water-replies.mjs';
import {whatsappOutbound} from '../lib/outbound-message.mjs';
const phone='+5511900000000',address='5511900000000@c.us',lid='123456789@lid';
const token='test-only-agent-token-at-least-32-characters';
const input=(extra={})=>recipientInput({name:'Ficticio',phone,audience:'perfil-1',events:['health.water_progress','health.diet_menu','financeiro.daily_summary','agent.notice'],permissions:['purchases.record'],...extra});
async function fixture(){
 const dir=await mkdtemp(path.join(tmpdir(),'agent-v2-')),repo=await VolumeRepository.open(dir);let time=Date.now(),serial=0;
 const worker=randomUUID();await repo.lease(worker);await repo.state(worker,'connected');
 const row=await repo.saveRecipient(input());
 const client={info:{wid:{_serialized:address,user:phone.slice(1)}},getContactLidAndPhone:async()=>[{pn:address,lid}]};
 const service=createAgentService({repository:repo,dataPath:dir,now:()=>time}),channel=createAgentChannel({client,repo,dataPath:dir,service});await channel.ready();
 const identity=project=>({request_id:randomUUID(),project});
 const message=(body,quoteId=null,extra={})=>({type:'chat',fromMe:true,to:address,from:address,body,id:{_serialized:'input-'+(++serial)},timestamp:Date.now()/1000,hasQuotedMsg:Boolean(quoteId),getQuotedMessage:async()=>({fromMe:true,id:{_serialized:quoteId},body:'🦉 Agente · Projeto ficticio'}),...extra});
 async function bind(project,where=address){
  const id=identity(project);await service.arm({...id,ttl_minutes:5});
  const notice=await service.notice(alertInput({source:'agente',event_type:'agent.notice',agent_project:project,agent_request:id,idempotency_key:'agent:'+id.request_id,title:'Ficticio',message:'Pergunta ficticia'}));
  const queued=await repo.enqueue(notice),job=await repo.claim(worker);assert.equal(job.id,queued.jobs[0].id);
  assert.equal(await channel.authorizeDelivery(job,row),true);const noticeId='notice-'+(++serial);
  await channel.bind(job,row,where,noticeId);await repo.finish(worker,job.id,'sent',null,noticeId);
  return {...id,noticeId,job};
 }
 return {dir,repo,worker,row,client,service,channel,identity,message,bind,advance:ms=>{time+=ms;},done:()=>rm(dir,{recursive:true,force:true})};
}

test('evento de agente é exclusivo e não altera água/compras ou aceita grupos',()=>{
 const base={source:'agente',event_type:'agent.notice',agent_project:'Projeto real',idempotency_key:'a',title:'Titulo',message:'Texto'};
 assert.equal(alertInput(base).audience,'agente');
 for(const changed of [{source:'superapp'},{event_type:'financeiro.daily_summary'},{agent_project:''},{agent_request:{request_id:randomUUID(),project:'Outro'}}])assert.throws(()=>alertInput({...base,...changed}));
 assert.throws(()=>input({target_type:'group',phone:null,group_id:'123@g.us',permissions:[]}),/agent_private_only/);
 assert.equal(replacementScope({event_type:'agent.notice',audience:'perfil-1'},address),null);
 assert.notEqual(replacementScope({event_type:'health.water_progress',audience:'perfil-1'},address),null);
 const text=whatsappOutbound({...base,agent_request:{request_id:randomUUID(),project:'Projeto real'}});
 assert.match(text,/^🦉 Agente/u);assert.match(text,/CITANDO/);assert.doesNotMatch(text,/resumo financeiro|Clareza hoje/);
});

test('duas perguntas e projetos ficam isolados; bot, texto avulso e áudio não viram resposta',async()=>{
 const f=await fixture();try{
  const a=await f.bind('Projeto A'),b=await f.bind('Projeto B');
  for(const msg of [f.message('🦉 Agente · aviso'),f.message('segue'),f.message('200 ml'),f.message('',null,{type:'ptt'}),f.message('continue',a.noticeId,{fromMe:false,from:'5521900000000@c.us'}),f.message('continue',a.noticeId,{isForwarded:true})])await f.channel.message(msg);
  assert.equal((await f.service.list(a,0)).messages.length,0);assert.equal((await f.service.list(b,0)).messages.length,0);
  const response=f.message('Revise os testes do projeto A',a.noticeId);assert.equal(await f.channel.message(response),true);await f.channel.message(response);
  const one=await f.service.list(a,0);assert.equal(one.messages.length,1);assert.equal(one.messages[0].request_id,a.request_id);assert.equal(one.armed,false);
  assert.equal((await f.service.list(b,0)).messages.length,0);
  await f.channel.message(f.message(`/agente ${b.request_id} encerra`));assert.equal((await f.service.list(b,0)).messages[0].text,'encerra');
  assert.equal((await f.service.list(a,one.messages[0].id)).messages.length,0);
  await assert.rejects(f.service.list({...a,project:'Projeto B'},0),/agent_request_not_found/);
 }finally{await f.done();}
});

test('PN/LID do próprio número é resolvido; revogação, expiração e encerramento bloqueiam captura',async()=>{
 const f=await fixture();try{
  const a=await f.bind('Projeto LID');f.client.info.wid={_serialized:lid,user:'123456789'};
  await f.channel.message(f.message('continue',a.noticeId,{to:lid}));assert.equal((await f.service.list(a,0)).messages.length,1);
  const b=await f.bind('Projeto expirado');f.advance(6*60000);
  await f.channel.message(f.message('continue',b.noticeId));assert.equal((await f.service.list(b,0)).messages.length,0);
  const c=await f.bind('Projeto fechado');await f.service.close(c);await f.service.close(c);
  await f.channel.message(f.message('continue',c.noticeId));assert.equal((await f.service.list(c,0)).messages.length,0);
  const d=await f.bind('Projeto revogado');await f.repo.saveRecipient(input({events:['health.water_progress'],permissions:['purchases.record']}));
  assert.equal(await f.channel.message(f.message('continue',d.noticeId)),true);await assert.rejects(f.service.list(d,0),/no_authorized_agent_recipient/);
 }finally{await f.done();}
});

test('inbox é durável, deduplica, expurga em leitura e limita avisos sem tocar mensageria.json',async()=>{
 const f=await fixture();try{
  const a=await f.bind('Projeto persistente');await f.channel.message(f.message('revisar',a.noticeId));
  const again=createAgentService({repository:f.repo,dataPath:f.dir});assert.equal((await again.list(a,0)).messages.length,1);
  const rawBefore=await readFile(f.repo.file,'utf8');
  for(let i=0;i<10;i++)await(await f.service.store()).notice('key-'+i,'Projeto limite');
  await assert.rejects((await f.service.store()).notice('excesso','Projeto limite'),/agent_notice_rate_limited/);
  await(await f.service.store()).notice('key-0','Projeto limite');assert.equal(await readFile(f.repo.file,'utf8'),rawBefore);
  f.advance(25*3600000);await assert.rejects(f.service.list(a,0),/agent_request_not_found/);
  const state=JSON.parse(await readFile(path.join(f.dir,'agent-inbox.json'),'utf8'));assert.equal(state.messages.length,0);
 }finally{await f.done();}
});

test('API exige token e request identificado; aviso usa destinatário existente e não canal financeiro',async()=>{
 const f=await fixture();let server;try{
  const handler=createHandler({repository:f.repo,env:{APP_ORIGIN:'https://painel.example',ADMIN_TOKEN:'admin-test-only-at-least-32-characters',INTEGRATION_TOKEN:token}});
  server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api/control`;
  const post=(action,body,bearer=token)=>fetch(base+'?action='+action,{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const identity=f.identity('Projeto API');
  assert.equal((await post('agent-arm',identity,'wrong')).status,401);
  assert.equal((await post('agent-arm',{ttl_minutes:60})).status,400);
  assert.equal((await fetch(base+'?action=agent-inbox&since=0',{headers:{Authorization:'Bearer '+token}})).status,400);
  const armed=await post('agent-arm',identity);assert.equal(armed.status,202);assert.equal((await armed.json()).audience,'perfil-1');
  const event={source:'agente',event_type:'agent.notice',agent_project:identity.project,agent_request:identity,idempotency_key:'api-agent-1',title:'Ficticio',message:'Pergunta ficticia'};
  await f.repo.saveRecipient(input({phone:'+5521900000000',name:'Outro',events:['agent.notice']}));
  const response=await post('event',event);assert.equal(response.status,202);assert.equal((await response.json()).jobs.length,1);
  const jobs=(await f.repo.read()).deliveries;assert.equal(jobs[0].recipient_id,f.row.id);assert.equal(jobs[0].audience,'perfil-1');assert.equal(jobs[0].agent_request.request_id,identity.request_id);
  assert.equal((await post('event',{...event,source:'superapp'})).status,400);
  assert.equal((await post('event',{...event,event_type:'financeiro.daily_summary'})).status,400);
  const get=await fetch(base+'?action=agent-inbox&request_id='+identity.request_id+'&project='+encodeURIComponent(identity.project)+'&since=0',{headers:{Authorization:'Bearer '+token}});
  assert.equal(get.status,200);assert.deepEqual((await get.json()).messages,[]);
  assert.equal((await post('agent-close',identity)).status,200);
  assert.equal((await f.repo.recipients()).find(r=>r.id===f.row.id).audience,'perfil-1');
  const health=await(await fetch(base+'?action=session')).json();assert.deepEqual(health.agent_channel,{version:2,available:true});
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.done();}
});

test('falha da inbox não impede água/compras; resposta do agente não cancela compra pendente',async()=>{
 const f=await fixture();try{
  let records=0,serial=0,water=0;
  const env={WHATSAPP_PURCHASE_ENABLED:'true',WHATSAPP_PURCHASE_OWNER_PHONE:phone,WHATSAPP_PURCHASE_CALLBACK_TOKEN:token,SUPERAPP_API_ORIGIN:'https://example.invalid',GROQ_API_KEY:'test-only-placeholder'};
  const purchases=createWhatsAppPurchases({client:f.client,repo:f.repo,worker:f.worker,env,Poll:class{},extract:async()=>({status:'ready',reason:'none',date:brazilDate(),items:[{description:'Ficticio',amount_cents:1000,payment:'debito_pix'}]}),record:async()=>{records++;},send:async()=>({id:{$1:'buy-'+(++serial)}})});
  const a=await f.bind('Projeto isolado');
  async function dispatch(message,channel=f.channel){if(await channel.message(message))return;await purchases.message(message);}
  await dispatch(f.message('gastei 10 reais na padaria'));const before=(await f.repo.purchaseState()).sessions[f.row.id].draft;
  await dispatch(f.message('continue',a.noticeId));assert.equal((await f.repo.purchaseState()).sessions[f.row.id].draft.id,before.id);assert.equal((await f.repo.purchaseState()).sessions[f.row.id].draft.status,'draft');assert.equal(records,0);
  const broken=createAgentChannel({client:f.client,repo:f.repo,dataPath:f.dir,service:{store:async()=>{throw new Error('private detail');}}});
  assert.equal(await broken.message(f.message('200 ml','water-id',{getQuotedMessage:async()=>({fromMe:true,id:{$1:'water-id'},body:'💧 Hora de beber água!'})})),false);
  assert.equal(await broken.message(f.message(`/agente ${a.request_id} continue`)),true);
  const date=brazilDate(),key=`agua:${date}:agent-audit`;
  await f.repo.enqueue(alertInput({source:'superapp',event_type:'health.water_progress',audience:'perfil-1',idempotency_key:key,title:'Ficticio',message:'Ficticio',water_prompt:{profile_id:'perfil-1',date,dedupe_key:key,signature:'a'.repeat(64)}}));
  const job=await f.repo.claim(f.worker);await f.repo.bindWater(f.worker,job.id,address,'water-id');await f.repo.finish(f.worker,job.id,'sent',null,'water-poll');
  const replies=createWaterReplies({client:f.client,repo:f.repo,worker:f.worker,send:async()=>({id:'feedback'}),request:async()=>{water++;return {ok:true,duplicate:false,profile_name:'Ficticio',amount_ml:200,realizado_ml:200,meta_ml:2000,remaining_ml:1800};}});
  const message=f.message('200 ml','water-id',{getQuotedMessage:async()=>({fromMe:true,id:{$1:'water-id'},body:'💧 Hora de beber água!'})});
  if(!await broken.message(message))await replies.message(message);assert.equal(water,1);assert.equal(records,0);
 }finally{await f.done();}
});


test('aviso técnico do agente não herda limpeza de água nem perde riscos citados',()=>{
 const text=whatsappOutbound({event_type:'agent.notice',agent_project:'Projeto real',title:'Revisão',message:'A frase antiga era: Quanto você bebeu agora?\nNAO VALIDADO EM PRODUCAO. Não autorize sem revisar.'});
 assert.match(text,/Quanto você bebeu agora/);assert.match(text,/NAO VALIDADO EM PRODUCAO/);assert.match(text,/Não autorize/);
});

test('falha transitória ao resolver LID do proprietário recupera sob demanda e em background',async()=>{
 const f=await fixture();try{
  const a=await f.bind('Projeto recuperação');let fail=true,lookups=0,writes=0,time=Date.now();
  const client={info:{wid:{_serialized:lid,user:'123456789'}},getContactLidAndPhone:async()=>{lookups++;if(fail)throw new Error('metadata unavailable');return[{lid,pn:address}];}};
  const service={...f.service,store:async()=>{const original=await f.service.store();return{setOwner:async phone=>{const result=await original.setOwner(phone);writes++;return result;}};}};
  const c=createAgentChannel({client,repo:f.repo,dataPath:f.dir,service,clock:()=>time});await assert.rejects(c.ready());
  fail=false;assert.equal(await c.authorizeDelivery(a.job,f.row),true);assert.equal(writes,1);
  fail=true;const d=createAgentChannel({client,repo:f.repo,dataPath:f.dir,service,clock:()=>time});await assert.rejects(d.ready());
  fail=false;time+=31000;d.refresh();
  for(let i=0;i<200&&writes<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(writes,2);assert.ok(lookups>=4);
 }finally{await f.done();}
});
