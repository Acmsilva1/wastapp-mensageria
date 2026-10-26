import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {recipientInput,interactionVersion} from '../lib/domain.mjs';
import {Repository} from '../lib/repository.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {createWhatsAppPurchases,recordWhatsAppPurchase,purchaseTextIntent,prunePurchaseState} from '../worker/whatsapp-purchases.mjs';
import {extractPurchases,validatePurchaseExtraction,validateAudioMetadata,validateAudioBytes,transcribePurchaseAudio} from '../worker/purchase-groq.mjs';
const {Poll}=createRequire(import.meta.url)('whatsapp-web.js');
const phone='+5511900000000',address='5511900000000@c.us',lid='123456789012345@lid';
const env={WHATSAPP_PURCHASE_ENABLED:'true',WHATSAPP_PURCHASE_OWNER_PHONE:phone,WHATSAPP_PURCHASE_CALLBACK_TOKEN:'test-purchase-token-at-least-32-characters',SUPERAPP_API_ORIGIN:'https://super.example',GROQ_API_KEY:'test-only-placeholder'};
const items=[{description:'Padaria',amount_cents:3550,payment:'debito'}];
const output=(changes={})=>({status:'ready',reason:'none',date:'2026-10-26',items:structuredClone(items),...changes});

async function fixture(mode){
 let db,dir,repo;
 if(mode==='sql'){
  db=new PGlite();
  for(const file of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','004_water_replies.sql','005_message_replacement.sql','006_whatsapp_purchases.sql','007_interaction_permissions.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
 }else{dir=await mkdtemp(path.join(os.tmpdir(),'purchase-flow-'));repo=await VolumeRepository.open(dir);}
 const worker=randomUUID();await repo.lease(worker);
 const recipient=await repo.saveRecipient(recipientInput({name:'Autorizado',phone,audience:'perfil-a',events:[],permissions:['purchases.record']}));
 let time=Date.parse('2026-10-26T15:00:00Z'),serial=0,extracts=0,records=0,downloads=0,failRecord=false,failReceipt=false;
 const sent=[],requests=[],inputs=[];
 const client={info:{wid:{_serialized:address,user:phone.slice(1)}},getContactLidAndPhone:async()=>[{pn:address,lid}]};
 const factory=(extra={})=>createWhatsAppPurchases({client,repo,worker,env,Poll,now:()=>time,
  extract:async(text,context)=>{extracts++;inputs.push({text,context});return output();},
  record:async(draft)=>{records++;requests.push(structuredClone(draft));if(failRecord)throw new Error('network_failure');return {ok:true,status:'saved',request_id:draft.id,duplicate:records>1,count:draft.items.length,total_cents:draft.items.reduce((s,i)=>s+i.amount_cents,0),date:draft.date};},
  send:async(to,content)=>{if(failReceipt&&typeof content==='string'&&content.startsWith('✅'))throw new Error('network_failure');const id='out-'+(++serial);sent.push({to,content,id});return {id:{$1:id}};},...extra});
 const message=(text='Gastei 35,50 na padaria no débito',quote=null,changes={})=>({type:'chat',body:text,id:{_serialized:'in-'+(++serial)},to:address,from:address,fromMe:true,timestamp:time/1000,hasQuotedMsg:Boolean(quote),getQuotedMessage:async()=>({fromMe:true,id:{$1:quote}}),...changes});
 const vote=(draft,confirm=true,changes={})=>({voter:{$1:address},parentMessage:{to:address,id:{$1:draft.poll_id}},selectedOptions:[{localId:confirm?0:1,name:(draft.poll_choices || ['Confirmar','Cancelar'])[confirm?0:1]}],...changes});
 return {repo,recipient,state:async()=> (await repo.purchaseState()).sessions?.[recipient.id] || {},worker,db,dir,factory,message,vote,sent,requests,inputs,get extracts(){return extracts;},get records(){return records;},get downloads(){return downloads;},download(){downloads++;return null;},setFailRecord(v){failRecord=v;},setFailReceipt(v){failReceipt=v;},advance(ms){time+=ms;},close:async()=>{if(db)await db.close();if(dir)await rm(dir,{recursive:true,force:true});}};
}

for(const mode of ['sql','volume']){
 test(`${mode}: rascunho não grava; dono/grupo/eco/água isolados; confirmação idempotente após reiniciar`,async()=>{
  const f=await fixture(mode);try{
   let h=f.factory();
   for(const changes of [{fromMe:false,from:'5511999999999@c.us'},{to:'5511999999999@c.us'},{to:'123@g.us'},{isForwarded:true}])await h.message(f.message(undefined,null,changes));
   await h.message(f.message('💧 Hora de beber água!'));await h.message(f.message('200 ml'));
   assert.equal(f.extracts,0);assert.equal(f.records,0);
   const initial=f.message();await h.message(initial);await h.message(initial);assert.equal(f.extracts,1);assert.equal(f.records,0);
   const draft=(await f.state()).draft;assert.equal(draft.status,'draft');assert.equal(draft.items[0].amount_cents,3550);assert.equal(f.sent.length,2);
   await h.message(f.message('sim'));assert.equal(f.records,0);
   await h.vote(f.vote(draft,true,{parentMessage:{to:address,id:{_serialized:'forged'}}}));assert.equal(f.records,0);
   if(mode==='volume')f.repo=await VolumeRepository.open(f.dir);
   h=f.factory();await h.vote(f.vote(draft));assert.equal(f.records,1);
   assert.equal((await f.state()).draft.status,'saved');assert.equal((await f.state()).draft.items,undefined);
   await h.vote(f.vote(draft));assert.equal(f.records,1);assert.match(f.sent.at(-1).content,/já confirmado/);
  }finally{await f.close();}
 });
 test(`${mode}: correção invalida voto anterior, cancelamento não grava, prazo não renova`,async()=>{
  const f=await fixture(mode);try{
   const h=f.factory({extract:async(text,context)=>output({items:[{...items[0],amount_cents:context?4280:3550}]})});
   await h.message(f.message());const old=(await f.state()).draft;
   f.advance(60000);await h.message(f.message('Na verdade foram42,80 no Pix',old.preview_ids[0]));const fresh=(await f.state()).draft;
   assert.equal(fresh.revision,2);assert.equal(fresh.expires_at,old.expires_at);assert.equal(fresh.items[0].amount_cents,4280);
   await h.vote(f.vote(old));assert.equal(f.records,0);await h.vote(f.vote(fresh,false));assert.equal(f.records,0);assert.equal((await f.state()).draft.status,'cancelled');
   await h.message(f.message());const pending=(await f.state()).draft;f.advance(16*60000);await h.vote(f.vote(pending));assert.equal(f.records,0);assert.equal((await f.state()).draft.status,'expired');
  }finally{await f.close();}
 });
 test(`${mode}: timeout conserva UUID/itens; resposta perdida recupera recibo sem gravar de novo`,async()=>{
  const f=await fixture(mode);try{
   const h=f.factory();await h.message(f.message());const draft=(await f.state()).draft;
   f.setFailRecord(true);await h.vote(f.vote(draft));assert.equal((await f.state()).draft.status,'submitting');
   await h.vote(f.vote(draft,false));assert.equal((await f.state()).draft.status,'submitting');
   await h.message(f.message('Troque para 99 no débito',draft.preview_ids[0]));assert.equal(f.extracts,1);
   f.setFailRecord(false);f.setFailReceipt(true);await h.vote(f.vote(draft));assert.equal((await f.state()).draft.status,'saved');
   assert.equal(f.requests[0].id,f.requests[1].id);assert.deepEqual(f.requests[0].items,f.requests[1].items);
   f.setFailReceipt(false);await f.factory().vote(f.vote(draft));assert.equal(f.records,2);assert.match(f.sent.at(-1).content,/já confirmado/);
  }finally{await f.close();}
 });
 test(`${mode}: esclarecimento tem contexto; áudio não confirma; limite e lease protegem estado`,async()=>{
  const f=await fixture(mode);try{
   let calls=0;
   const h=f.factory({extract:async(text,context)=>{calls++;return calls===1?output({status:'clarify',reason:'missing_amount',items:[{...items[0],amount_cents:null}]}):output();},transcribe:async()=> 'sim'});
   await h.message(f.message('Paguei na padaria no débito'));const question=(await f.state()).draft;
   await h.message(f.message('35,50',question.question_ids[0]));const draft=(await f.state()).draft;assert.equal(draft.status,'draft');
   const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
   await h.message(f.message('',draft.preview_ids[0],{type:'ptt',hasMedia:true,_data:{mimetype:'audio/wav',duration:2,size:44},downloadMedia:async()=>({mimetype:'audio/wav',data:wav.toString('base64')})}));
   assert.equal(f.records,0,'STT sim nunca confirma um registro');
   await assert.rejects(f.repo.changePurchaseState(randomUUID(),()=>{}),/worker_lease_lost/);
   if(mode==='sql')assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='mensageria.purchase_state'::regclass")).rows[0].relrowsecurity,true);
  }finally{await f.close();}
 });
}

test('Groq usa schema estrito e valida negócio; ausência/negativas e áudio são tratados sem suposições',async()=>{
 let calls=0;
 const fetcher=async(url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.model,'openai/gpt-oss-120b');assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.reasoning_effort,'medium');assert.equal(options.headers['User-Agent'],'superapp-mensageria/1.0');return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output())}}]})};};
 assert.equal((await extractPurchases('padaria35no débito',null,{env,fetcher,now:new Date('2026-10-26T15:00:00Z')})).status,'ready');
 assert.equal((await extractPurchases('comprei no crédito',null,{env,fetcher})).status,'reject');assert.equal(calls,1);
 assert.equal((await extractPurchases('padaria35',null,{env,fetcher,now:new Date('2026-10-26T15:00:00Z')})).status,'ready');
 assert.equal(purchaseTextIntent('não salvar'),'cancel');assert.equal(purchaseTextIntent('pode registrar'),'confirm');
 assert.throws(()=>validateAudioMetadata({type:'ptt',hasMedia:true,_data:{mimetype:'audio/ogg',size:10,duration:61}}),/purchase_audio_invalid/);
 assert.throws(()=>validateAudioBytes(Buffer.from('bad'),'audio/ogg'),/purchase_audio_invalid/);
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
 assert.equal(await transcribePurchaseAudio(wav,'audio/wav',{env,fetcher:async(url,options)=>{assert.match(url,/transcriptions$/);assert.equal(options.body.get('language'),'pt');return {ok:true,json:async()=>({text:'Compra fictícia'})};}}),'Compra fictícia');
});
test('contrato do callback rejeita recibo incoerente e preserva UUID da confirmação',async()=>{
 const draft={id:randomUUID(),owner_phone:phone,authorization_id:randomUUID(),authorization_version:'a'.repeat(64),date:'2026-10-26',items};let body;
 const result=await recordWhatsAppPurchase(draft,{env,fetcher:async(url,options)=>{assert.equal(url,'https://super.example/api/financeiro?resource=whatsapp-purchases');body=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true,status:'saved',duplicate:false,request_id:draft.id,count:1,total_cents:3550,date:draft.date})};}});
 assert.equal(body.confirmed,true);assert.equal(body.sender_phone,phone);assert.equal(body.authorization_id,draft.authorization_id);assert.equal(body.authorization_version,draft.authorization_version);assert.equal(result.total_cents,3550);
 await assert.rejects(recordWhatsAppPurchase(draft,{env,fetcher:async()=>({ok:true,json:async()=>({ok:true,status:'saved'})})}),/purchase_record_unverified/);
 const state=prunePurchaseState({draft:{status:'draft',items,expires_at:'2000-01-01T00:00:00Z'}});assert.ok(!state.draft || !state.draft.items);
});
test('limite por minuto bloqueia chamadas adicionais e libera depois da janela',async()=>{
 const f=await fixture('volume');let calls=0;
 try{
  const h=f.factory({extract:async()=>{calls++;return output({status:'ignore',reason:'not_purchase',items:[]});}});
  for(let i=0;i<7;i++)await h.message(f.message(`Anota ${i+1} reais no Pix`));
  assert.equal(calls,6);assert.equal(f.records,0);assert.match(f.sent.at(-1).content,/limite/);
  f.advance(61000);await h.message(f.message('Anota20reais no Pix'));assert.equal(calls,7);
 }finally{await f.close();}
});
test('pendente recupera prévia após reinício sem IA nova ou mudança do pedido submetido',async()=>{
 const f=await fixture('volume');try{
  let h=f.factory();await h.message(f.message());const old=(await f.state()).draft;
  await h.message(f.message('/pendente'));const fresh=(await f.state()).draft;
  assert.equal(f.extracts,1);assert.equal(fresh.id,old.id);assert.notEqual(fresh.poll_id,old.poll_id);
  f.setFailRecord(true);await h.vote(f.vote(fresh));assert.equal((await f.state()).draft.status,'submitting');
  await f.factory().message(f.message('/pendente'));const restored=(await f.state()).draft;
  assert.equal(restored.status,'submitting');assert.equal(restored.id,old.id);assert.deepEqual(restored.items,old.items);assert.equal(f.records,1);
 }finally{await f.close();}
});

for(const mode of ['sql','volume'])test(`${mode}: pessoas autorizadas têm rascunhos isolados; revogação bloqueia áudio e confirmação`,async()=>{
 const f=await fixture(mode);try{
  const otherPhone='+5521900000000',otherAddress='5521900000000@c.us';
  const other=await f.repo.saveRecipient(recipientInput({name:'Outra pessoa',phone:otherPhone,audience:'2',events:[],permissions:['purchases.record']}));
  const h=f.factory();
  const incoming=(body,quote=null,extra={})=>f.message(body,quote,{fromMe:false,from:otherAddress,to:address,...extra});
  await h.message(f.message());await h.message(incoming('Anote padaria 35,50 no Pix'));
  const own=(await f.state()).draft,remote=(await f.repo.purchaseState()).sessions[other.id].draft;
  assert.notEqual(own.id,remote.id);assert.equal(remote.owner_phone,otherPhone);assert.equal(remote.authorization_id,other.id);
  // Sending to someone else from the connected device is not their consent.
  await h.message(f.message('confirmo',remote.preview_ids[0],{to:otherAddress}));assert.equal(f.records,0);
  await h.message(incoming('confirmo',own.preview_ids[0]));assert.equal(f.records,0);
  await h.vote(f.vote(remote,true,{voter:otherAddress,parentMessage:{to:otherAddress,id:{$1:remote.poll_id}}}));
  assert.equal(f.records,1);assert.equal(f.requests[0].owner_phone,otherPhone);assert.equal((await f.state()).draft.status,'draft');
  await f.repo.toggleRecipient(f.recipient.id,false);
  await h.vote(f.vote(own));assert.equal(f.records,1);
  const before=f.extracts;
  await h.message(f.message('',null,{type:'ptt',hasMedia:true,_data:{mimetype:'audio/ogg',size:50,duration:2},downloadMedia:async()=>f.download()}));
  assert.equal(f.downloads,0);assert.equal(f.extracts,before);
  await f.repo.toggleRecipient(f.recipient.id,true);
  await h.vote(f.vote(own));assert.equal(f.records,1,'old grant cannot confirm after reauthorization');
  await h.message(f.message());const fresh=(await f.state()).draft;assert.notEqual(fresh.id,own.id);
  await h.vote(f.vote(fresh));assert.equal(f.records,2);
 }finally{await f.close();}
});

test('revogação durante interpretação descarta resultado e não publica prévia',async()=>{
 const f=await fixture('volume');try{
  const h=f.factory({extract:async()=>{await f.repo.toggleRecipient(f.recipient.id,false);return output();}});
  await h.message(f.message());assert.equal(f.sent.length,0);assert.equal(f.records,0);
 }finally{await f.close();}
});

test('reautorizar pedido incerto exige prévia nova e conserva UUID e itens',async()=>{
 const f=await fixture('volume');try{
  const h=f.factory();await h.message(f.message());const old=(await f.state()).draft;
  f.setFailRecord(true);await h.vote(f.vote(old));assert.equal(f.records,1);
  await f.repo.toggleRecipient(f.recipient.id,false);await f.repo.toggleRecipient(f.recipient.id,true);
  await h.vote(f.vote(old));assert.equal(f.records,1);
  await h.message(f.message('/pendente'));const fresh=(await f.state()).draft;
  assert.equal(fresh.id,old.id);assert.deepEqual(fresh.items,old.items);assert.notEqual(fresh.poll_id,old.poll_id);assert.notEqual(fresh.authorization_version,old.authorization_version);
  f.setFailRecord(false);await h.vote(f.vote(fresh));assert.equal(f.records,2);assert.equal((await f.state()).draft.status,'saved');
  assert.equal(f.requests[0].id,f.requests[1].id);
 }finally{await f.close();}
});

test('migração do rascunho legado mantém UUID do dono sem compartilhar com outras pessoas',async()=>{
 const f=await fixture('volume');try{
  const id=randomUUID();
  await f.repo.changePurchaseState(f.worker,root=>{root.draft={id,owner_phone:phone,address,status:'submitting',code:'LEGADO-1',date:'2026-10-26',items,expires_at:'2026-10-26T15:15:00Z',preview_ids:['legacy-preview'],poll_id:'legacy-poll'};});
  const h=f.factory();await h.message(f.message('/pendente'));const draft=(await f.state()).draft;
  assert.equal(draft.id,id);assert.equal(draft.authorization_id,f.recipient.id);assert.equal((await f.repo.purchaseState()).draft,undefined);
  await h.vote(f.vote(draft));assert.equal(f.records,1);assert.equal(f.requests[0].id,id);
 }finally{await f.close();}
});

test('descrição e valor bastam; débito/Pix é único e ausências reais continuam pendentes',async()=>{
 const date='2026-10-26';
 for(const payment of [null,'debito','pix','debito_pix']){
  const result=validatePurchaseExtraction(output({items:[{description:'Padaria',amount_cents:1000,payment}]}),date);
  assert.equal(result.status,'ready');assert.equal(result.items[0].payment,'debito_pix');
 }
 for(const [field,reason] of [['description','missing_description'],['amount_cents','missing_amount']]){
  const result=validatePurchaseExtraction(output({items:[{...items[0],[field]:null,payment:null}]}),date);
  assert.equal(result.status,'clarify');assert.equal(result.reason,reason);
 }
 const missingLegacy=validatePurchaseExtraction(output({status:'clarify',reason:'missing_payment',items:[{...items[0],payment:null}]}),date);
 assert.equal(missingLegacy.status,'ready');assert.equal(missingLegacy.reason,'none');
 const f=await fixture('volume');try{
  const h=f.factory({extract:(text,context)=>extractPurchases(text,context,{env,now:new Date(date+'T15:00:00Z'),fetcher:async(url,options)=>{
   const body=JSON.parse(options.body);assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.properties.payment.enum,['debito_pix']);
   assert.match(body.messages[0].content,/descrição e valor bastam/);
   return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output({items:[{description:'Padaria',amount_cents:1000,payment:'debito_pix'}]}))}}]})};
  }})});
  await h.message(f.message('gastei 10 reais na padaria'));const draft=(await f.state()).draft;
  assert.equal(draft.status,'draft');assert.equal(draft.items[0].payment,'debito_pix');assert.equal(f.records,0);
  assert.match(f.sent[0].content,/Padaria.*10,00/);assert.match(f.sent[0].content,/Despesas variáveis/);assert.doesNotMatch(f.sent[0].content,/Categoria|pagou no/);
  await h.vote(f.vote(draft));assert.equal(f.records,1);
 }finally{await f.close();}
});

for(const mode of ['sql','volume'])for(const legacyStatus of ['clarification','preparing'])test(`${mode}/${legacyStatus}: pergunta antiga de pagamento vira prévia via pendente; pedido submetido mantém pagamento legado`,async()=>{
 const f=await fixture(mode);try{
  const oldId=randomUUID();
  await f.repo.changePurchaseState(f.worker,root=>{root.sessions={[f.recipient.id]:{version:interactionVersion(f.recipient),draft:{id:oldId,owner_phone:phone,address,authorization_id:f.recipient.id,authorization_version:interactionVersion(f.recipient),status:legacyStatus,date:'2026-10-26',items:[{...items[0],payment:null}],expires_at:'2026-10-26T15:15:00Z',question_ids:['old-payment-question']}}};});
  const h=f.factory();await h.message(f.message('/pendente'));const draft=(await f.state()).draft;
  assert.equal(f.extracts,0);assert.equal(draft.id,oldId);assert.equal(draft.status,'draft');assert.equal(draft.items[0].payment,'debito_pix');assert.equal(f.sent.length,2);
  const raw=[{...items[0],payment:'pix'}];
  await f.repo.changePurchaseState(f.worker,root=>{root.sessions[f.recipient.id].draft.items=raw;root.sessions[f.recipient.id].draft.status='submitting';});
  await h.message(f.message('/pendente'));const retry=(await f.state()).draft;
  assert.deepEqual(retry.items,raw);await h.vote(f.vote(retry));assert.deepEqual(f.requests[0].items,raw);
 }finally{await f.close();}
});

test('gastos por extenso e correlatos acionam o bot; perguntas usam o mascote amigável',async()=>{
 const f=await fixture('volume');try{
  const h=f.factory({extract:async()=>output({status:'ignore',reason:'not_purchase',items:[]})});
  for(const text of ['Desembolsei dez no estacionamento','O almoço custou quinze','Meu gasto foi vinte na feira'])await h.message(f.message(text));
  // The custom extractor above replaces the fixture counter, so use persisted calls.
  assert.equal((await f.state()).calls.length,3);
  const ask=f.factory({extract:async()=>output({status:'clarify',reason:'missing_amount',items:[{...items[0],amount_cents:null,payment:'debito_pix'}]})});
  await ask.message(f.message('gastei na padaria'));assert.match(f.sent.at(-1).content,/^🦉 /u);assert.doesNotMatch(f.sent.at(-1).content,/🤖|débito ou no Pix/u);
 }finally{await f.close();}
});

for(const mode of ['sql','volume'])test(`${mode}: nova despesa substitui prévia não enviada e somente Sim da enquete atual registra`,async()=>{
 const f=await fixture(mode);try{
  const h=f.factory(),initial=f.message('gastei 10 na padaria');await h.message(initial);const old=(await f.state()).draft;
  assert.deepEqual(old.poll_choices,['Sim','Não']);
  assert.deepEqual(f.sent[1].content.pollOptions.map(option=>option.name),['Sim','Não']);assert.equal(f.sent[1].content.options.allowMultipleAnswers,false);
  await h.message(f.message('200 ml'));await h.message(f.message('🦉 Mensagem automática'));await h.message(initial);
  await h.message(f.message('Gastei 20 no mercado',null,{fromMe:false,from:'5511999999999@c.us'}));
  assert.equal((await f.state()).draft.id,old.id);
  await h.message(f.message('gastei 20 no mercado'));const fresh=(await f.state()).draft;
  assert.notEqual(fresh.id,old.id);assert.equal(fresh.revision,1);assert.equal(f.records,0);assert.equal(f.inputs[1].context,null);
  await h.vote(f.vote(old));await h.message(f.message('sim',old.preview_ids[0]));assert.equal(f.records,0);
  await h.vote(f.vote(fresh,true,{selectedOptions:[{localId:0,name:'Não'}]}));assert.equal(f.records,0);
  await f.factory().vote(f.vote(fresh));assert.equal(f.records,1);assert.equal(f.requests[0].id,fresh.id);
  await f.factory().vote(f.vote(fresh));assert.equal(f.records,1,'restart preserves Sim/Não when saved');
  await h.message(f.message('comprei 30 na feira'));const cancelled=(await f.state()).draft;
  await h.vote(f.vote(cancelled,false));assert.equal(f.records,1);assert.equal((await f.state()).draft.status,'cancelled');
 }finally{await f.close();}
});

for(const mode of ['sql','volume'])test(`${mode}: mensagem independente encerra rascunho; replay não cancela o próximo`,async()=>{
 const f=await fixture(mode);try{
  const h=f.factory();await h.message(f.message());const old=(await f.state()).draft;
  const unrelated=f.message('oi');await h.message(unrelated);
  assert.equal((await f.state()).draft.status,'cancelled');assert.equal(f.extracts,1);assert.equal(f.records,0);
  await h.message(f.message('comprei 20 na farmácia'));const fresh=(await f.state()).draft;
  assert.notEqual(fresh.id,old.id);
  await h.message(unrelated);assert.equal((await f.state()).draft.id,fresh.id);assert.equal((await f.state()).draft.status,'draft');
  await h.message(f.message('não'));assert.equal((await f.state()).draft.status,'cancelled');assert.equal(f.records,0);
 }finally{await f.close();}
});

test('pedido com resultado incerto conserva UUID e itens ao chegar nova mensagem e voto Não',async()=>{
 const f=await fixture('volume');try{
  const h=f.factory();await h.message(f.message());const old=(await f.state()).draft;
  f.setFailRecord(true);await h.vote(f.vote(old));assert.equal(f.records,1);
  await h.message(f.message('gastei 99 no mercado'));await h.vote(f.vote(old,false));
  const pending=(await f.state()).draft;assert.equal(pending.status,'submitting');assert.equal(pending.id,old.id);assert.deepEqual(pending.items,old.items);assert.equal(f.extracts,1);
  f.setFailRecord(false);await h.vote(f.vote(pending));assert.equal(f.requests[1].id,old.id);assert.deepEqual(f.requests[1].items,old.items);
 }finally{await f.close();}
});

test('enquete legada Confirmar/Cancelar continua válida e eco de Sim isolado não registra',async()=>{
 const f=await fixture('volume');try{
  const h=f.factory();await h.message(f.message());const fresh=(await f.state()).draft;
  await h.message(f.message('sim'));assert.equal(f.records,0);assert.equal((await f.state()).draft.id,fresh.id);
  await f.repo.changePurchaseState(f.worker,root=>{delete root.sessions[f.recipient.id].draft.poll_choices;});
  const legacy=(await f.state()).draft;await h.vote(f.vote(legacy));assert.equal(f.records,1);
 }finally{await f.close();}
});

test('áudio de água e confirmação falada não substituem compra pendente nem gravam',async()=>{
 const f=await fixture('volume');try{
  let transcript='';const h=f.factory({transcribe:async()=>transcript});
  await h.message(f.message());const old=(await f.state()).draft;
  const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
  for(const text of ['bebi 200 ml','bebi duzentos mililitros','sim']){
   transcript=text;f.advance(61000);
   await h.message(f.message('',null,{type:'ptt',hasMedia:true,_data:{mimetype:'audio/wav',duration:2,size:44},downloadMedia:async()=>({mimetype:'audio/wav',data:wav.toString('base64')})}));
   assert.equal((await f.state()).draft.id,old.id);assert.equal((await f.state()).draft.status,'draft');assert.equal(f.extracts,1);assert.equal(f.records,0);
  }
  assert.match(f.sent.at(-1).content,/selecione Sim/);
 }finally{await f.close();}
});
