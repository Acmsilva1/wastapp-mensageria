import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractPurchasesLocal,extractPurchasesResilient} from '../worker/purchase-groq.mjs';
import {waterOutbound} from '../lib/water-message-ai.mjs';

const now=new Date('2026-11-04T15:00:00Z');
const job={event_type:'health.water_progress',title:'Lembrete de água - André',message:'💧 André, hora de beber água.',idempotency_key:'agua:2026-11-04:11:00:1',audience:'1'};

test('água usa escolha validada da Groq sem permitir que ela escreva a mensagem',async()=>{
 const text=await waterOutbound(job,{env:{GROQ_API_KEY:'test-key'},fetcher:async(_url,options)=>{
  const request=JSON.parse(options.body);
  assert.equal(request.response_format.json_schema.strict,true);
  assert.deepEqual(request.messages[1].content.includes('André'),false);
  return {ok:true,json:async()=>({choices:[{message:{content:'{"choice":2}'}}]})};
 }});
 assert.match(text,/garrafinha/);assert.match(text,/André/);
});

test('água cai em escolha Node determinística quando Groq falta, falha ou responde inválido',async()=>{
 const noKey=await waterOutbound(job,{env:{}});
 const failed=await waterOutbound(job,{env:{GROQ_API_KEY:'x'},fetcher:async()=>{throw new Error('offline');}});
 const invalid=await waterOutbound(job,{env:{GROQ_API_KEY:'x'},fetcher:async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"choice":99}'}}]})})});
 assert.equal(failed,noKey);assert.equal(invalid,noKey);assert.match(noKey,/💧/);
});

test('lembretes de água variam opções e integram progresso',async()=>{
 const withProgress={...job,message:'💧 Hora de beber água!\nMeta: 2000 ml\nJá registradas: 600 / 2000 ml\nFaltam 1400 ml para a meta.'};
 const text=await waterOutbound(withProgress,{env:{}});
 assert.match(text,/600 de 2000 ml/);
 // Variação em diferentes horários mesmo sem IA
 const morning=await waterOutbound({...job,idempotency_key:'agua:2026-11-04:09:00:1'},{env:{}});
 const afternoon=await waterOutbound({...job,idempotency_key:'agua:2026-11-04:15:00:1'},{env:{}});
 assert.match(morning,/💧/);
 assert.match(afternoon,/💧/);
 assert.notEqual(morning,afternoon);
});

test('parser Node interpreta compra simples, valor por extenso e correção com contexto',()=>{
 let result=extractPurchasesLocal('Gastei R$ 35,50 na padaria',null,{now});
 assert.deepEqual(result.items,[{description:'Padaria',amount_cents:3550,payment:'debito_pix'}]);
 result=extractPurchasesLocal('Paguei trinta e cinco reais e cinquenta centavos na farmácia',null,{now});
 assert.deepEqual(result.items,[{description:'Farmacia',amount_cents:3550,payment:'debito_pix'}]);
 result=extractPurchasesLocal('na verdade foram 42,80', {items:[{description:'Mercado',amount_cents:4000,payment:'debito_pix'}]},{now});
 assert.deepEqual(result.items,[{description:'Mercado',amount_cents:4280,payment:'debito_pix'}]);
});

test('falha, limite e JSON inválido da Groq usam parser Node',async()=>{
 for(const fetcher of [async()=>{throw new Error('network');},async()=>({ok:false,status:429}),async()=>({ok:true,json:async()=>({choices:[{message:{content:'não-json'}}]})})]){
  const result=await extractPurchasesResilient('gastei 10 reais na padaria',null,{env:{GROQ_API_KEY:'x'},fetcher,now});
  assert.equal(result.status,'ready');assert.equal(result.items[0].amount_cents,1000);assert.equal(result.items[0].description,'Padaria');
 }
});

test('sem chave Groq a compra continua ativa pelo parser Node',async()=>{
 const result=await extractPurchasesResilient('comprei 20 no mercado',null,{env:{},now});
 assert.equal(result.status,'ready');assert.deepEqual(result.items,[{description:'Mercado',amount_cents:2000,payment:'debito_pix'}]);
});
