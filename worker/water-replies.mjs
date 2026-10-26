import { recipientAccepts } from '../lib/domain.mjs';
import { metadataLookup } from './group-target.mjs';

export const WATER_AMOUNTS = Object.freeze([100,200,300,400,500,1000,2000]);
export const WATER_OPTIONS = WATER_AMOUNTS.map(n => n>=1000 ? `${n/1000} L` : `${n} ml`);
export const WATER_QUESTION = '💧 Quanto você bebeu agora? Escolha uma opção. Cada lembrete registra apenas uma vez. Se necessário, responda a este lembrete com o volume, por exemplo: 200 ml.';
export function parseWaterAmount(value) {
  const text=String(value ?? '').trim();
  const litres=text.match(/^([12])\s*(?:l|lt|litros?)$/i);
  if (litres) return Number(litres[1])*1000;
  return /^(100|200|300|400|500|1000|2000)\s*(?:ml)?$/i.test(text) ? Number(text.match(/^\d+/)[0]) : null;
}
export function brazilDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
const serialized=value => typeof value==='string' ? value : value?._serialized;
async function actorPhone(client, actor) {
  const id=serialized(actor);
  if (/^\d{8,15}@c\.us$/.test(id || '')) return `+${id.split('@')[0]}`;
  if (!/^\d+@lid$/.test(id || '')) return null;
  const mappings=await metadataLookup(()=>client.getContactLidAndPhone([id]), 10000);
  const pn=mappings?.find(row=>row.lid===id)?.pn;
  return /^\d{8,15}@c\.us$/.test(pn || '') ? `+${pn.split('@')[0]}` : null;
}
export function confirmation(result) {
  return `✅ ${result.duplicate ? 'Este lembrete já foi registrado' : `Registro realizado: ${result.amount_ml} ml`} — ${String(result.profile_name).slice(0,80)}.\n💧 Hoje: ${result.realizado_ml} / ${result.meta_ml} ml.\n${result.remaining_ml>0 ? `Faltam ${result.remaining_ml} ml para sua meta diária.` : '🎯 Meta diária atingida!'}`;
}
export function callbackConfig(env=process.env) {
  try {
    const origin=new URL(env.SUPERAPP_API_ORIGIN);
    const token=env.WHATSAPP_WATER_CALLBACK_TOKEN || '';
    if (origin.protocol!=='https:' || origin.username || origin.password || token.length<32 || /[\r\n]/.test(token)) return null;
    return {url:new URL('/api/saude?resource=whatsapp-water',origin.origin).href,token};
  } catch { return null; }
}
export async function requestWater(prompt, amount, {env=process.env,fetcher=fetch}={}) {
  const config=callbackConfig(env);
  if (!config) throw new Error('water_configuration_required');
  const response=await fetcher(config.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},
    body:JSON.stringify({water_prompt:prompt,amount_ml:amount}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) {
    let payload; try { payload=await response.json(); } catch {}
    const error=new Error(response.status===409 && payload?.error==='water_goal_required' ? 'water_goal_required' : response.status===409?'water_already_recorded':response.status===410?'water_prompt_expired':'water_callback_failed');
    error.retryable=response.status>=500; throw error;
  }
  const data=await response.json();
  if (data?.ok!==true || typeof data.duplicate!=='boolean' || data.amount_ml!==amount || typeof data.profile_name!=='string'
    || ![data.realizado_ml,data.meta_ml,data.remaining_ml].every(n=>Number.isInteger(n) && n>=0) || data.meta_ml===0
    || data.remaining_ml!==Math.max(0,data.meta_ml-data.realizado_ml)) throw new Error('water_invalid_response');
  return data;
}
export function createWaterReplies({client,repo,worker,env=process.env,send=(address,text)=>client.sendMessage(address,text,{linkPreview:false}),request=requestWater}) {
  // A bounded queue prevents vote storms from creating parallel callbacks or unbounded memory.
  let tail=Promise.resolve(), pending=0;
  async function processAnswer({messageId,actor,address,amount,own=false}) {
    if (!messageId || !address || !WATER_AMOUNTS.includes(amount)) return;
    const job=await repo.waterDelivery(messageId);
    if (!job || job.water_address!==address || job.water_prompt.date!==brazilDate()) return;
    const recipient=await repo.recipient(job.recipient_id);
    if (!recipientAccepts(recipient,job)) return;
    const phone=await actorPhone(client,actor);
    if (!phone) return;
    const account=client.info?.wid?.user ? `+${client.info.wid.user}` : null;
    // Self messages are accepted only when the connected number is explicitly authorized.
    if (own && phone!==account) return;
    if (recipient.target_type==='group') {
      if (recipient.group_id!==address) return;
      const authorized=(await repo.recipients()).some(r=>r.target_type!=='group' && r.phone===phone && recipientAccepts(r,job));
      if (!authorized) return;
    } else if (recipient.phone!==phone) return;
    await repo.heartbeat(worker);
    try {
      let result;
      for(let attempt=0;attempt<2;attempt++) {
        try { result=await request(job.water_prompt,amount,{env}); break; }
        catch(error) { if(attempt || error.retryable===false || ['water_already_recorded','water_goal_required','water_prompt_expired','water_configuration_required','water_invalid_response'].includes(error.message)) throw error; }
      }
      await repo.heartbeat(worker);
      await send(address,confirmation(result));
    } catch(error) {
      const text=error.message==='water_already_recorded' ? 'Este lembrete já foi registrado. Para outro consumo, use o app ou o próximo lembrete.'
        : error.message==='water_goal_required' ? 'Configure sua meta diária de água em ml no Super App antes de registrar o consumo.'
        : error.message==='water_prompt_expired' ? 'Este lembrete expirou. Use o lembrete de hoje.'
        : 'Não foi possível confirmar o registro agora. Responda a este mesmo lembrete com o mesmo volume para tentar novamente sem duplicar.';
      await send(address,text);
    }
  }
  function queue(answer) {
    if(pending>=30) return Promise.resolve();
    pending++;
    const task=tail.then(()=>processAnswer(answer));
    tail=task.catch(()=>{}).finally(()=>pending--);
    return task;
  }
  return {
    vote(vote) {
      if(vote.selectedOptions?.length!==1) return Promise.resolve();
      const parent=vote.parentMessage;
      const option=vote.selectedOptions[0];
      // Local IDs are authoritative for polls created with our fixed option order.
      const amount=WATER_AMOUNTS[option.localId];
      if(!amount || (option.name && parseWaterAmount(option.name)!==amount)) return Promise.resolve();
      return queue({messageId:parent?.id?._serialized || serialized(vote.parentMsgKey),actor:vote.voter,address:parent?.to,amount});
    },
    async message(message) {
      if(message.isForwarded || !message.hasQuotedMsg || !['chat',undefined].includes(message.type)) return;
      const amount=parseWaterAmount(message.body);
      if(!amount) return;
      const quoted=await metadataLookup(()=>message.getQuotedMessage(),10000);
      if(!quoted?.fromMe) return;
      const address=message.fromMe ? message.to : message.from;
      return queue({messageId:quoted.id?._serialized,actor:message.author || (message.fromMe ? serialized(client.info?.wid) : message.from),address,amount,own:message.fromMe});
    }
  };
}
