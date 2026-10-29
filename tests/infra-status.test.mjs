import test from 'node:test';
import assert from 'node:assert/strict';
import { alertInput,recipientInput,recipientAccepts } from '../lib/domain.mjs';
const alert={source:'central',event_type:'infra.vps_status',audience:'1',idempotency_key:'central:test:0146ff26-19ba-44ac-8acc-3afc468aaecd',title:'Central VPS',message:'📊 Central de Comando\nOperação normal.'};
const recipient={name:'Perfil teste',phone:'+5511900000000',audience:'1',target_type:'phone',events:['infra.vps_status'],enabled:true,permissions:[]};
test('infra usa origem propria, perfil exato e nenhum fanout financeiro',()=>{
 const normalized=alertInput(alert);const r=recipientInput(recipient);
 assert.equal(recipientAccepts(r,normalized),true);
 assert.equal(recipientAccepts({...r,audience:'2'},normalized),false);
 assert.equal(recipientAccepts({...r,target_type:'group'},normalized),false);
 assert.equal(recipientAccepts({...r,follow_session:true},normalized),false);
 assert.equal(recipientAccepts({...r,events:['financeiro.daily_summary']},normalized),false);
});
test('infra recusa grupos, conta remetente e troca de origem/evento',()=>{
 assert.throws(()=>recipientInput({...recipient,target_type:'group',group_id:'120363000000000@g.us',phone:null}));
 assert.throws(()=>recipientInput({...recipient,follow_session:true}));
 assert.throws(()=>alertInput({...alert,source:'superapp'}));
 assert.throws(()=>alertInput({...alert,event_type:'financeiro.daily_summary'}));
 assert.throws(()=>alertInput({...alert,agent_project:'central-comando-vps'}));
});
