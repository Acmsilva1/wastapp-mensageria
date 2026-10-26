import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {Repository} from '../lib/repository.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {createWhatsAppPurchases,recordWhatsAppPurchase,purchaseTextIntent,prunePurchaseState} from '../worker/whatsapp-purchases.mjs';
import {extractPurchases,validateAudioMetadata,validateAudioBytes,transcribePurchaseAudio} from '../worker/purchase-groq.mjs';
const {Poll}=createRequire(import.meta.url)('whatsapp-web.js');
const phone='+5511900000000',address='5511900000000@c.us',lid='123456789012345@lid';
const env={WHATSAPP_PURCHASE_ENABLED:'true',WHATSAPP_PURCHASE_OWNER_PHONE:phone,WHATSAPP_PURCHASE_CALLBACK_TOKEN:'test-purchase-token-at-least-32-characters',SUPERAPP_API_ORIGIN:'https://super.example',GROQ_API_KEY:'test-only-placeholder'};
const items=[{description:'Padaria',amount_cents:3550,payment:'debito'}];
const output=(changes={})=>({status:'ready',reason:'none',date:'2026-10-26',items:structuredClone(items),...changes});

async function fixture(mode){
 let db,dir,repo;
 if(mode==='sql'){
  db=new PGlite();
  for(const file of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','004_water_replies.sql','005_message_replacement.sql','006_whatsapp_purchases.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
 }else{dir=await mkdtemp(path.join(os.tmpdir(),'purchase-flow-'));repo=await VolumeRepository.open(dir);}
 const worker=randomUUID();await repo.lease(worker);
 let time=Date.parse('2026-10-26T15:00:00Z'),serial=0,extracts=0,records=0,downloads=0,failRecord=false,failReceipt=false;
 const sent=[],requests=[],inputs=[];
 const client={info:{wid:{_serialized:address,user:phone.slice(1)}},getContactLidAndPhone:async()=>[{pn:address,lid}]};
 const factory=(extra={})=>createWhatsAppPurchases({client,repo,worker,env,Poll,now:()=>time,
  extract:async(text,context)=>{extracts++;inputs.push({text,context});return output();},
  record:async(draft)=>{records++;requests.push(structuredClone(draft));if(failRecord)throw new Error('network_failure');return {ok:true,status:'saved',request_id:draft.id,duplicate:records>1,count:draft.items.length,total_cents:draft.items.reduce((s,i)=>s+i.amount_cents,0),date:draft.date};},
  send:async(to,content)=>{if(failReceipt&&typeof content==='string'&&content.startsWith('✅'))throw new Error('network_failure');const id='out-'+(++serial);sent.push({to,content,id});return {id:{$1:id}};},...extra});
 const message=(text='Gastei 35,50 na padaria no débito',quote=null,changes={})=>({type:'chat',body:text,id:{_serialized:'in-'+(++serial)},to:address,from:address,fromMe:true,timestamp:time/1000,hasQuotedMsg:Boolean(quote),getQuotedMessage:async()=>({fromMe:true,id:{$1:quote}}),...changes});
 const vote=(draft,confirm=true,changes={})=>({voter:{$1:address},parentMessage:{to:address,id:{$1:draft.poll_id}},selectedOptions:[{localId:confirm?0:1,name:confirm?'Confirmar':'Cancelar'}],...changes});
 return {repo,worker,db,dir,factory,message,vote,sent,requests,inputs,get extracts(){return extracts;},get records(){return records;},get downloads(){return downloads;},download(){downloads++;return null;},setFailRecord(v){failRecord=v;},setFailReceipt(v){failReceipt=v;},advance(ms){time+=ms;},close:async()=>{if(db)await db.close();if(dir)await rm(dir,{recursive:true,force:true});}};
}

for(const mode of ['sql','volume']){
 test(`${mode}: rascunho não grava; dono/grupo/eco/água isolados; confirmação idempotente após reiniciar`,async()=>{
  const f=await fixture(mode);try{
   let h=f.factory();
   for(const changes of [{fromMe:false},{to:'5511999999999@c.us'},{to:'123@g.us'},{isForwarded:true}])await h.message(f.message(undefined,null,changes));
   await h.message(f.message('💧 Hora de beber água!'));await h.message(f.message('200 ml'));
   assert.equal(f.extracts,0);assert.equal(f.records,0);
   const initial=f.message();await h.message(initial);await h.message(initial);assert.equal(f.extracts,1);assert.equal(f.records,0);
   const draft=(await f.repo.purchaseState()).draft;assert.equal(draft.status,'draft');assert.equal(draft.items[0].amount_cents,3550);assert.equal(f.sent.length,2);
   await h.message(f.message('sim'));assert.equal(f.records,0);
   await h.vote(f.vote(draft,true,{parentMessage:{to:address,id:{_serialized:'forged'}}}));assert.equal(f.records,0);
   if(mode==='volume')f.repo=await VolumeRepository.open(f.dir);
   h=f.factory();await h.vote(f.vote(draft));assert.equal(f.records,1);
   assert.equal((await f.repo.purchaseState()).draft.status,'saved');assert.equal((await f.repo.purchaseState()).draft.items,undefined);
   await h.vote(f.vote(draft));assert.equal(f.records,1);assert.match(f.sent.at(-1).content,/já confirmado/);
  }finally{await f.close();}
 });
 test(`${mode}: correção invalida voto anterior, cancelamento não grava, prazo não renova`,async()=>{
  const f=await fixture(mode);try{
   const h=f.factory({extract:async(text,context)=>output({items:[{...items[0],amount_cents:context?4280:3550}]})});
   await h.message(f.message());const old=(await f.repo.purchaseState()).draft;
   f.advance(60000);await h.message(f.message('Na verdade foram42,80 no Pix',old.preview_ids[0]));const fresh=(await f.repo.purchaseState()).draft;
   assert.equal(fresh.revision,2);assert.equal(fresh.expires_at,old.expires_at);assert.equal(fresh.items[0].amount_cents,4280);
   await h.vote(f.vote(old));assert.equal(f.records,0);await h.vote(f.vote(fresh,false));assert.equal(f.records,0);assert.equal((await f.repo.purchaseState()).draft.status,'cancelled');
   await h.message(f.message());const pending=(await f.repo.purchaseState()).draft;f.advance(16*60000);await h.vote(f.vote(pending));assert.equal(f.records,0);assert.equal((await f.repo.purchaseState()).draft.status,'expired');
  }finally{await f.close();}
 });
 test(`${mode}: timeout conserva UUID/itens; resposta perdida recupera recibo sem gravar de novo`,async()=>{
  const f=await fixture(mode);try{
   const h=f.factory();await h.message(f.message());const draft=(await f.repo.purchaseState()).draft;
   f.setFailRecord(true);await h.vote(f.vote(draft));assert.equal((await f.repo.purchaseState()).draft.status,'submitting');
   await h.vote(f.vote(draft,false));assert.equal((await f.repo.purchaseState()).draft.status,'submitting');
   await h.message(f.message('Troque para 99 no débito',draft.preview_ids[0]));assert.equal(f.extracts,1);
   f.setFailRecord(false);f.setFailReceipt(true);await h.vote(f.vote(draft));assert.equal((await f.repo.purchaseState()).draft.status,'saved');
   assert.equal(f.requests[0].id,f.requests[1].id);assert.deepEqual(f.requests[0].items,f.requests[1].items);
   f.setFailReceipt(false);await f.factory().vote(f.vote(draft));assert.equal(f.records,2);assert.match(f.sent.at(-1).content,/já confirmado/);
  }finally{await f.close();}
 });
 test(`${mode}: esclarecimento tem contexto; áudio não confirma; limite e lease protegem estado`,async()=>{
  const f=await fixture(mode);try{
   let calls=0;
   const h=f.factory({extract:async(text,context)=>{calls++;return calls===1?output({status:'clarify',reason:'missing_amount',items:[{...items[0],amount_cents:null}]}):output();},transcribe:async()=> 'sim'});
   await h.message(f.message('Paguei na padaria no débito'));const question=(await f.repo.purchaseState()).draft;
   await h.message(f.message('35,50',question.question_ids[0]));const draft=(await f.repo.purchaseState()).draft;assert.equal(draft.status,'draft');
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
 assert.equal((await extractPurchases('padaria35',null,{env,fetcher,now:new Date('2026-10-26T15:00:00Z')})).reason,'missing_payment');
 assert.equal(purchaseTextIntent('não salvar'),'cancel');assert.equal(purchaseTextIntent('pode registrar'),'confirm');
 assert.throws(()=>validateAudioMetadata({type:'ptt',hasMedia:true,_data:{mimetype:'audio/ogg',size:10,duration:61}}),/purchase_audio_invalid/);
 assert.throws(()=>validateAudioBytes(Buffer.from('bad'),'audio/ogg'),/purchase_audio_invalid/);
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
 assert.equal(await transcribePurchaseAudio(wav,'audio/wav',{env,fetcher:async(url,options)=>{assert.match(url,/transcriptions$/);assert.equal(options.body.get('language'),'pt');return {ok:true,json:async()=>({text:'Compra fictícia'})};}}),'Compra fictícia');
});
test('contrato do callback rejeita recibo incoerente e preserva UUID da confirmação',async()=>{
 const draft={id:randomUUID(),date:'2026-10-26',items};let body;
 const result=await recordWhatsAppPurchase(draft,{env,fetcher:async(url,options)=>{assert.equal(url,'https://super.example/api/financeiro?resource=whatsapp-purchases');body=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true,status:'saved',duplicate:false,request_id:draft.id,count:1,total_cents:3550,date:draft.date})};}});
 assert.equal(body.confirmed,true);assert.equal(body.sender_phone,phone);assert.equal(result.total_cents,3550);
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
  let h=f.factory();await h.message(f.message());const old=(await f.repo.purchaseState()).draft;
  await h.message(f.message('/pendente'));const fresh=(await f.repo.purchaseState()).draft;
  assert.equal(f.extracts,1);assert.equal(fresh.id,old.id);assert.notEqual(fresh.poll_id,old.poll_id);
  f.setFailRecord(true);await h.vote(f.vote(fresh));assert.equal((await f.repo.purchaseState()).draft.status,'submitting');
  await f.factory().message(f.message('/pendente'));const restored=(await f.repo.purchaseState()).draft;
  assert.equal(restored.status,'submitting');assert.equal(restored.id,old.id);assert.deepEqual(restored.items,old.items);assert.equal(f.records,1);
 }finally{await f.close();}
});
