import {randomUUID} from 'node:crypto';
import {serializedId} from './serialized-id-compat.mjs';
import {metadataLookup} from './group-target.mjs';
import {interactionRecipient,interactionVersion} from '../lib/domain.mjs';
import {brazilDate,parseWaterAmount,actorPhone} from './water-replies.mjs';
import {extractPurchases,transcribePurchaseAudio,validateAudioMetadata,validatePurchaseExtraction,MAX_AUDIO_BYTES} from './purchase-groq.mjs';

const TTL=15*60*1000,DAY=24*60*60*1000;
const BOT_PREFIX=/^(?:🧾|🦉|🤖|✅|❌|💧|🍽️|📊|💰|🐷|🚗|🥗|💙|💪|✨)/u;
const normalize=text=>String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const money=cents=>(cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export function purchaseConfig(env=process.env) {
 try {
  if(env.WHATSAPP_PURCHASE_ENABLED!=='true')return null;
  const origin=new URL(env.SUPERAPP_API_ORIGIN),phone=String(env.WHATSAPP_PURCHASE_OWNER_PHONE || '').trim(),token=String(env.WHATSAPP_PURCHASE_CALLBACK_TOKEN || '').trim();
  if(origin.protocol!=='https:' || origin.username || origin.password || !/^\+[1-9]\d{7,14}$/.test(phone) || token.length<32 || /[\r\n]/.test(token) || !env.GROQ_API_KEY)return null;
  return {phone,token,url:new URL('/api/financeiro?resource=whatsapp-purchases',origin.origin).href};
 }catch{return null;}
}
export function prunePurchaseState(state,now=Date.now()) {
 state.processed=(Array.isArray(state.processed)?state.processed:[]).filter(item=>item.at>now-DAY).slice(-500);
 state.outbound=(Array.isArray(state.outbound)?state.outbound:[]).filter(item=>item.at>now-DAY).slice(-500);
 state.calls=(Array.isArray(state.calls)?state.calls:[]).filter(at=>at>now-3600000).slice(-60);
 if(state.draft && ['draft','clarification','preparing'].includes(state.draft.status) && Date.parse(state.draft.expires_at)<=now) {
  state.draft={id:state.draft.id,status:'expired',date:state.draft.date,expires_at:state.draft.expires_at,preview_ids:state.draft.preview_ids || [],question_ids:state.draft.question_ids || []};
 }
 if(state.draft && ['saved','cancelled','failed','expired'].includes(state.draft.status) && Date.parse(state.draft.expires_at)<=now-DAY)state.draft=null;
 return state;
}
export function purchaseTextIntent(text,code='') {
 let value=normalize(text);
 if(code)value=value.replace(normalize(code),'').trim();
 if(/\b(?:cancelar|cancele|cancela|desisto|desistir|esquece|esqueca)\b/.test(value) || /\bnao\s*[,!]?\s*(?:confirm|registr|salv|lanc)/.test(value) || /^(?:nao|negativo)[.!]*$/.test(value))return 'cancel';
 value=value.replace(/[.,!?]/g,'').replace(/\s+/g,' ').trim();
 return /^(?:sim|confirmo|confirmar|confirma|pode confirmar|pode registrar|pode salvar|pode lancar|sim pode registrar|sim confirmo|isso mesmo pode registrar)$/.test(value)?'confirm':'edit';
}
export function purchasePreview(draft) {
 const lines=draft.items.map((item,index)=>`${index+1}. ${item.description} — ${money(item.amount_cents)}`);
 return `🧾 Confira a compra — ${draft.code}\n\n${lines.join('\n')}\n\nTotal: ${money(draft.items.reduce((sum,item)=>sum+item.amount_cents,0))}\nData: ${draft.date.split('-').reverse().join('/')} (hoje)\nDestino: Despesas variáveis · Débito/Pix\n\nAinda não registrei. Escolha Confirmar ou Cancelar na enquete. Também pode responder a esta prévia com “confirmo”, “cancelar” ou uma correção. Cada nova prévia invalida a anterior.`;
}
const questions={missing_description:'Qual foi a compra? Informe a descrição.',missing_amount:'Qual foi o valor exato da compra?',ambiguous_amount:'O valor ficou ambíguo. Informe o valor exato e a qual compra ele pertence.'};
export async function recordWhatsAppPurchase(draft,{env=process.env,fetcher=fetch}={}) {
 const config=purchaseConfig(env);if(!config)throw new Error('purchase_disabled');
 const body={action:'record',request_id:draft.id,sender_phone:draft.owner_phone,authorization_id:draft.authorization_id,authorization_version:draft.authorization_version,confirmed:true,date:draft.date,items:draft.items};
 const response=await fetcher(config.url,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','User-Agent':'superapp-mensageria/1.0'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(response.status===409?'purchase_conflict':response.status===410?'purchase_expired':'purchase_record_unavailable');
 const result=await response.json(),total=draft.items.reduce((sum,item)=>sum+item.amount_cents,0);
 if(result?.ok!==true || result.status!=='saved' || result.request_id!==draft.id || typeof result.duplicate!=='boolean' || result.count!==draft.items.length || result.total_cents!==total || result.date!==draft.date)throw new Error('purchase_record_unverified');
 return result;
}

function createPurchaseSession({client,repo,worker,env=process.env,scope,authorize,Poll,extract=extractPurchases,transcribe=transcribePurchaseAudio,record=recordWhatsAppPurchase,now=()=>Date.now(),send=(address,content)=>client.sendMessage(address,content,{linkPreview:false,waitUntilMsgSent:true})}) {
 let tail=Promise.resolve(),queued=0;
 const config=purchaseConfig(env);
 const change=fn=>repo.changePurchaseState(worker,state=>{prunePurchaseState(state,now());return fn(state);});
 const load=()=>change(state=>structuredClone(state));
 async function identities() {
  if(!await authorize())return null;
  const expected=config.phone.slice(1)+'@c.us';
  const mappings=typeof client.getContactLidAndPhone==='function' ? await metadataLookup(()=>client.getContactLidAndPhone([expected]),10000) : [];
  const match=mappings?.find(m=>m.pn===expected);
  return new Set([expected,match?.lid].filter(Boolean));
 }
 async function outbound(address,content) {
  if(!await authorize())throw new Error('purchase_forbidden');
  const message=await metadataLookup(()=>send(address,content),30000),id=serializedId(message?.id);
  if(!id)throw new Error('purchase_reply_unconfirmed');
  await change(state=>state.outbound.push({id,at:now()}));return id;
 }
 async function reserve(id,calls=0) {
  return change(state=>{
   if(state.processed.some(item=>item.id===id))return false;
   if(calls && (state.calls.filter(at=>at>now()-60000).length+calls>6 || state.calls.length+calls>60))throw new Error('purchase_rate_limited');
   state.processed.push({id,at:now()});for(let i=0;i<calls;i++)state.calls.push(now());return true;
  });
 }
 async function publish(draft,extracted,address) {
  const revision=(draft?.revision || 0)+1,id=draft?.id || randomUUID();
  const prepared={id,owner_phone:config.phone,authorization_id:scope.id,authorization_version:scope.version,address,revision,code:`${id.slice(0,6).toUpperCase()}-${revision}`,date:extracted.date,items:extracted.items,status:'preparing',created_at:draft?.created_at || new Date(now()).toISOString(),expires_at:draft?.expires_at || new Date(now()+TTL).toISOString(),preview_ids:[],question_ids:[],poll_id:null};
  await change(state=>{state.draft=prepared;});
  try {
   if(extracted.status==='clarify') {
    const question=questions[extracted.reason] || 'Informe a descrição e o valor exato da despesa.';
    const qid=await outbound(address,`🦉 ${question}\nResponda diretamente a esta mensagem. Ainda não registrei nada.`);
    await change(state=>{if(state.draft?.id===id && state.draft.revision===revision){state.draft.status='clarification';state.draft.question_ids=[qid];}});
   }else{
    const preview=await outbound(address,purchasePreview(prepared));
    const poll=await outbound(address,new Poll(`🧾 ${prepared.code}: confirmar o registro destas compras?`,['Confirmar','Cancelar'],{allowMultipleAnswers:false}));
    await change(state=>{if(state.draft?.id===id && state.draft.revision===revision){state.draft.status='draft';state.draft.preview_ids=[preview,poll];state.draft.poll_id=poll;}});
   }
  }catch(error){await change(state=>{if(state.draft?.id===id)state.draft={id,status:'failed',date:prepared.date,expires_at:prepared.expires_at};});throw error;}
 }
 async function confirm(draft,address) {
  if(!await authorize() || draft.authorization_id!==scope.id || draft.authorization_version!==scope.version)return;
  if(draft.status==='saved') {
   await outbound(address,`✅ Registro já confirmado no Super App.\n${draft.count} ${draft.count===1?'item':'itens'} — ${money(draft.total_cents)}\nDespesas variáveis · Débito/Pix.`);
   return;
  }
  if(!['draft','submitting'].includes(draft.status))return;
  if(draft.status==='draft' && (draft.date!==brazilDate(new Date(now())) || Date.parse(draft.expires_at)<=now()))return;
  await change(state=>{if(state.draft?.id===draft.id)state.draft.status='submitting';});
  let result;
  try {result=await record(draft,{env});}catch{
   await outbound(address,'🦉 Não consegui confirmar se o Super App gravou. O pedido ficou protegido, sem alterar os itens. Confirme novamente respondendo à mesma prévia ou usando sua enquete; a repetição não duplica a compra.');
   return;
  }
  await change(state=>{state.draft={id:draft.id,status:'saved',address:draft.address,owner_phone:draft.owner_phone,authorization_id:draft.authorization_id,authorization_version:draft.authorization_version,code:draft.code,revision:draft.revision,date:draft.date,expires_at:draft.expires_at,count:result.count,total_cents:result.total_cents,preview_ids:draft.preview_ids,poll_id:draft.poll_id};});
  try {await outbound(address,`✅ ${result.duplicate?'Registro já confirmado':'Compra registrada'} no Super App.\n${result.count} ${result.count===1?'item':'itens'} — ${money(result.total_cents)}\nDespesas variáveis · Débito/Pix.`);}catch{console.error('purchase_receipt_unconfirmed');}
 }
 async function cancel(draft,address) {
  if(draft.status==='submitting') {await outbound(address,'🦉 Este pedido já foi enviado para registro e ainda não tive a confirmação. Não posso afirmar que foi cancelado. Confirme novamente na mesma prévia para consultar o resultado sem duplicar.');return;}
  await change(state=>{state.draft={id:draft.id,status:'cancelled',date:draft.date,expires_at:draft.expires_at};});
  await outbound(address,'❌ Rascunho cancelado. Nenhuma compra foi enviada para registro.');
 }
 async function analyze(text,draft,address) {
  if(!await authorize())return;
  const extracted=await extract(text,draft?{items:draft.items,date:draft.date}:null,{env,now:new Date(now())});
  if(extracted.status==='cancel'){if(draft)await cancel(draft,address);return;}
  if(extracted.status==='ignore')return;
  if(extracted.status==='reject') {
   await outbound(address,extracted.reason==='different_date'?'🦉 Por aqui registro somente compras de hoje. Para outra data, use o Super App.':'🦉 Por aqui registro somente compras no débito ou Pix, sem crédito nem parcelas. Use o Super App para as demais formas.');return;
  }
  if(await authorize())await publish(draft,extracted,address);
 }
 async function processMessage(message) {
  if(!config || message.isForwarded || !['chat','audio','ptt'].includes(message.type))return false;
  const address=serializedId(message.fromMe ? message.to : message.from),id=serializedId(message.id);
  if(!address || !id || !/^\d+@(c\.us|lid)$/.test(address) || !Number.isFinite(message.timestamp) || Math.abs(now()/1000-message.timestamp)>TTL/1000)return false;
  const aliases=await identities();if(!aliases?.has(address))return false;
  if(message.type==='chat' && BOT_PREFIX.test(String(message.body || '').trim()))return false;
  const snapshot=await load();
  if(snapshot.outbound.some(item=>item.id===id) || snapshot.processed.some(item=>item.id===id) || await repo.knownBotMessage(id))return false;
  let quoteId=null;
  if(message.hasQuotedMsg) {
   const quoted=await metadataLookup(()=>message.getQuotedMessage(),10000);quoteId=serializedId(quoted?.id);
   if(!quoteId || quoted?.fromMe!==true)return false;
   if(await repo.knownBotMessage(quoteId))return false; // water/diet/financial alerts are not purchase drafts.
  }
  const draft=snapshot.draft;
  if(!quoteId && message.type==='chat' && /^(?:\/?pendente|ver compra pendente|mostrar compra pendente)$/.test(normalize(message.body))) {
   if(!await reserve(id))return true;
   if(draft?.status==='saved'){await confirm(draft,address);return true;}
   if(draft && ['draft','clarification','preparing','submitting'].includes(draft.status) && Array.isArray(draft.items)) {
    if(draft.status==='submitting') {
     const preview=await outbound(address,purchasePreview(draft));
     const poll=await outbound(address,new Poll(`🧾 ${draft.code}: consultar a confirmação deste mesmo pedido?`,['Confirmar','Cancelar'],{allowMultipleAnswers:false}));
     await change(state=>{if(state.draft?.id===draft.id){state.draft.preview_ids=[preview,poll];state.draft.poll_id=poll;}});
    }else{
     const extracted=validatePurchaseExtraction({status:'ready',reason:'none',date:draft.date,items:draft.items},brazilDate(new Date(now())));
     // A legacy ready preview keeps its exact items for idempotent recovery.
     if(draft.status==='draft')extracted.items=draft.items;
     await publish(draft,extracted,address);
    }
   }else await outbound(address,'🦉 Não há compra pendente. Envie a descrição e o valor da despesa. Exemplo: gastei 10 reais na padaria.');
   return true;
  }
  const linked=quoteId && draft && [...(draft.preview_ids || []),...(draft.question_ids || [])].includes(quoteId) && draft.address===address && draft.owner_phone===config.phone;
  if(quoteId && !linked)return false;
  if(!quoteId && message.type==='chat') {
   const text=String(message.body || '').trim();
   if(parseWaterAmount(text)!==null || /^(?:bebi|agua|água|hidratei).*\b(?:ml|litro|litros)\b/i.test(text))return false;
   if(!/pix|d[eé]bito|cr[eé]dito|gast(?:ei|o|ou|amos)|pagu(?:ei|ou)|pagamento|comprei|compra|cust(?:ou|aram)|desembols(?:ei|o)|saiu|sairam|saíram|ficou|deu|despesa|registr|anot|reais|r\$|\p{L}.*\d|\d.*\p{L}/iu.test(text))return false;
  }
  let text=String(message.body || '').trim();const audio=message.type!=='chat';
  if(linked && draft.status==='saved') {
   if(!audio && await reserve(id))await confirm(draft,address);
   return true;
  }
  if(linked && ['cancelled','expired','failed'].includes(draft.status))return true;
  if(linked && !audio) {
   const code=text.match(/\b[a-f\d]{6}-\d+\b/i)?.[0];if(code && normalize(code)!==normalize(draft.code))return true;
   const intent=purchaseTextIntent(text,draft.code);
   if(intent!=='edit') {if(!await reserve(id))return true;if(intent==='cancel')await cancel(draft,address);else if(draft.preview_ids?.includes(quoteId))await confirm(draft,address);return true;}
  }
  if(draft && ['draft','clarification','preparing','submitting'].includes(draft.status) && !linked) {
   if(await reserve(id))await outbound(address,'🦉 Há um pedido pendente. Responda à sua prévia atual para corrigir, confirmar ou cancelar antes de iniciar outra compra.');return true;
  }
  if(draft?.status==='submitting') {if(await reserve(id))await outbound(address,'🦉 Aguardo a confirmação deste pedido no Super App. Repita a confirmação na mesma prévia; por segurança não altero seus itens agora.');return true;}
  if(audio)validateAudioMetadata(message); // Scope and metadata precede download and AI calls.
  if(!await reserve(id,audio?2:1))return true;
  if(audio) {
   if(!await authorize())return true;
   const media=await metadataLookup(()=>message.downloadMedia(),15000);
   if(!media || typeof media.data!=='string' || media.data.length>Math.ceil(MAX_AUDIO_BYTES/3)*4+4)throw new Error('purchase_audio_invalid');
   const buffer=Buffer.from(media.data,'base64');
   try{if(!await authorize())return true;text=await transcribe(buffer,media.mimetype,{env});}finally{buffer.fill(0);media.data='';}
  }
  // Audio can only produce/revise a draft. A transcription such as 'sim' never records.
  await analyze(text,linked?draft:null,address);text='';return true;
 }
 async function processVote(vote) {
  if(!config || vote.selectedOptions?.length!==1)return false;
  const address=serializedId(vote.parentMessage?.to),pollId=serializedId(vote.parentMessage?.id) || serializedId(vote.parentMsgKey);
  const aliases=await identities();if(!aliases?.has(address) || !aliases.has(serializedId(vote.voter)))return false;
  const snapshot=await load(),draft=snapshot.draft;
  if(!draft || draft.address!==address || draft.owner_phone!==config.phone || draft.poll_id!==pollId || !['draft','submitting','saved'].includes(draft.status))return false;
  const option=vote.selectedOptions[0],intent=option.localId===0?'confirm':option.localId===1?'cancel':null;
  if(!intent || option.name && normalize(option.name)!==(intent==='confirm'?'confirmar':'cancelar'))return false;
  if(draft.status==='saved') {await confirm(draft,address);return true;}
  if(intent==='cancel')await cancel(draft,address);else await confirm(draft,address);return true;
 }
 function queue(action) {
  if(!config || queued>=8)return Promise.resolve(false);queued++;
  const task=tail.then(action).catch(()=>{console.error('purchase_processing_failed');return false;});
  tail=task.finally(()=>queued--);return task;
 }
 return {message:message=>queue(async()=>{
  try{return await processMessage(message);}catch(error){
   const address=serializedId(message.fromMe ? message.to : message.from),aliases=await identities();
   if(aliases?.has(address))await outbound(address,error?.message==='purchase_audio_invalid'?'🦉 Áudio recusado. Envie OGG, WAV ou M4A de até 60 segundos e 5 MB. Nenhuma compra foi enviada para registro.':error?.message==='purchase_rate_limited' || error?.message==='purchase_ai_rate_limited'?'🦉 Cheguei ao limite de consultas agora. Aguarde um pouco e envie a mensagem novamente. Nenhuma compra foi enviada para registro.':'🦉 Não consegui concluir esta solicitação agora. Tente novamente respondendo à mensagem atual ou consulte o Super App.');
   return false;
  }
 }),vote:vote=>queue(()=>processVote(vote))};
}

// Each authorized phone has its own durable draft, limits and confirmation IDs.
// The outer queue also bounds aggregate work across all authorized people.
export function createWhatsAppPurchases(options) {
 const {client,repo,worker,env=process.env}=options;
 let tail=Promise.resolve(),queued=0;
 const config=purchaseConfig(env);
 async function route(kind,event) {
  if(!config)return false;
  let address,actor;
  if(kind==='message') {
   if(event.isForwarded || !['chat','audio','ptt'].includes(event.type))return false;
   address=serializedId(event.fromMe ? event.to : event.from);
   actor=event.fromMe ? serializedId(client.info?.wid) : serializedId(event.from);
  }else{
   address=serializedId(event.parentMessage?.to);
   actor=serializedId(event.voter);
  }
  if(!/^\d+@(c\.us|lid)$/.test(address || '') || !/^\d+@(c\.us|lid)$/.test(actor || ''))return false;
  const phone=await actorPhone(client,actor);
  if(!phone || await actorPhone(client,address)!==phone)return false;
  const recipient=interactionRecipient(await repo.recipients(),phone,'purchases.record');
  if(!recipient)return false;
  const scope={id:recipient.id,version:interactionVersion(recipient)};
  const authorize=async()=>{
   const current=interactionRecipient(await repo.recipients(),phone,'purchases.record');
   return Boolean(current && current.id===scope.id && interactionVersion(current)===scope.version);
  };
  const scopedRepo={
   knownBotMessage:id=>repo.knownBotMessage(id),
   changePurchaseState:(lease,fn)=>repo.changePurchaseState(lease,root=>{
    root.sessions ||= {};
    // Adopt the previous owner-only draft once, without changing its request ID.
    if(!root.sessions[scope.id] && phone===config.phone && root.draft?.owner_phone===phone) {
     root.sessions[scope.id]={processed:root.processed || [],outbound:root.outbound || [],calls:root.calls || [],draft:{...root.draft,authorization_id:scope.id,authorization_version:scope.version}};
     delete root.draft;delete root.processed;delete root.outbound;delete root.calls;
    }
    const state=root.sessions[scope.id] ||= {};
    if(state.version && state.version!==scope.version && state.draft) {
     if(state.draft.status==='submitting') {
      // Preserve the uncertain request and require a fresh preview/confirmation.
      state.draft={...state.draft,authorization_version:scope.version,preview_ids:[],question_ids:[],poll_id:null};
     } else state.draft=null;
    }
    state.version=scope.version;
    return fn(state);
   })
  };
  const state=await scopedRepo.changePurchaseState(worker,s=>({blocked:false}));
  if(state===null)return false;
  const handler=createPurchaseSession({...options,repo:scopedRepo,scope,authorize,env:{...env,WHATSAPP_PURCHASE_OWNER_PHONE:phone}});
  return handler[kind](event);
 }
 function enqueue(kind,event) {
  if(!config || queued>=8)return Promise.resolve(false);
  queued++;
  const task=tail.then(()=>route(kind,event)).catch(()=>{console.error('purchase_processing_failed');return false;});
  tail=task.finally(()=>queued--);return task;
 }
 return {message:event=>enqueue('message',event),vote:event=>enqueue('vote',event)};
}
