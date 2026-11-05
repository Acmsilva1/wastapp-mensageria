import {createHash} from 'node:crypto';
import {whatsappOutbound} from './outbound-message.mjs';

export const WATER_MESSAGE_MODEL='openai/gpt-oss-120b';
const CHOICES=['original','pausa gentil','garrafinha','foco','autocuidado','movimento','ritmo','brinde'];
const CLOSER='💙 Um gole de cada vez. Você está cuidando de você.';

function cleanName(job) {
 const title=String(job?.title || '');
 const name=title.includes(' - ')?title.split(' - ').slice(1).join(' - ').trim():'';
 return name.replace(/[\r\n\x00-\x1f]/g,' ').replace(/\s+/g,' ').slice(0,60) || 'você';
}
function messages(job) {
 const name=cleanName(job),original=whatsappOutbound(job);
 return [
  original,
  `💧 ${name}, faça uma pausa gentil e beba um pouco de água.\n\nSeu corpo agradece esse cuidado simples ao longo do dia.\n\n${CLOSER}`,
  `💧 ${name}, sua garrafinha está chamando. Que tal alguns goles agora?\n\nManter a hidratação distribuída durante o dia ajuda a transformar cuidado em hábito.\n\n${CLOSER}`,
  `💧 ${name}, antes da próxima tarefa, reserve um instante para beber água.\n\nUma pausa curta pode ajudar você a retomar o dia com mais atenção.\n\n${CLOSER}`,
  `💧 ${name}, este é seu lembrete de autocuidado: água no copo e alguns goles sem pressa.\n\nHidratação também faz parte da sua rotina de bem-estar.\n\n${CLOSER}`,
  `💧 ${name}, se você esteve em movimento, aproveite para repor líquidos agora.\n\nSeu corpo perde água ao longo do dia e merece essa reposição.\n\n${CLOSER}`,
  `💧 ${name}, mantenha o ritmo com uma pausa para água.\n\nPequenos lembretes ajudam a cuidar da hidratação sem deixar tudo para o fim do dia.\n\n${CLOSER}`,
  `💧 ${name}, um brinde ao cuidado de hoje: pegue sua água e faça essa pausa.\n\nO básico bem cuidado faz diferença.\n\n${CLOSER}`,
 ].map(value=>value.slice(0,4000));
}
function fallbackIndex(job,count) {
 const key=String(job?.idempotency_key || `${job?.audience || ''}:${job?.created_at || ''}`);
 return createHash('sha256').update(key).digest().readUInt32BE(0)%count;
}
function providerKey(env) {
 const key=String(env.GROQ_API_KEY || '').trim();
 return key&&!/[\r\n]/.test(key)?key:null;
}
export async function waterOutbound(job,{env=process.env,fetcher=fetch}={}) {
 const candidates=messages(job),fallback=candidates[fallbackIndex(job,candidates.length)],key=providerKey(env);
 if(!key)return fallback;
 try {
  const hour=String(job?.idempotency_key || '').match(/:(\d{2}):\d{2}:/)?.[1] || null;
  const response=await fetcher('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','User-Agent':'superapp-mensageria/1.0'},body:JSON.stringify({model:WATER_MESSAGE_MODEL,temperature:0,max_completion_tokens:200,response_format:{type:'json_schema',json_schema:{name:'water_message_choice',strict:true,schema:{type:'object',additionalProperties:false,required:['choice'],properties:{choice:{type:'integer',minimum:0,maximum:candidates.length-1}}}}},messages:[{role:'system',content:'Escolha uma opção segura e acolhedora para um lembrete de hidratação. Você apenas escolhe o índice; não escreve a mensagem e não fornece orientação médica.'},{role:'user',content:JSON.stringify({hour,choices:CHOICES})}]}),redirect:'error',signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error(response.status===429?'water_ai_rate_limited':'water_ai_unavailable');
  const body=await response.json(),parsed=JSON.parse(body.choices?.[0]?.message?.content);
  if(!Number.isInteger(parsed?.choice)||parsed.choice<0||parsed.choice>=candidates.length)throw new Error('water_ai_invalid');
  return candidates[parsed.choice];
 } catch(error) {
  const code=['water_ai_rate_limited','water_ai_invalid'].includes(error?.message)?error.message:'water_ai_unavailable';
  console.warn(JSON.stringify({event:'water_message_fallback',code}));
  return fallback;
 }
}
