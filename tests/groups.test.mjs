import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../lib/repository.mjs';
import { recipientInput, alertInput } from '../lib/domain.mjs';
import { catalogGroups, recipientAddress, metadataLookup } from '../worker/group-target.mjs';
import { createHandler } from '../lib/http-handler.mjs';
import { makeSession } from '../lib/crypto.mjs';
let db, repo;
const groupId='120363123456789@g.us';
const input=(changes={})=>recipientInput({target_type:'group',group_id:groupId,name:'Meu grupo',audience:'1',events:['health.water_progress'],...changes});
before(async()=>{
 db=new PGlite();
 for(const f of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
 repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
});
after(async()=>db.close());
async function reset(){await db.exec("truncate mensageria.deliveries,mensageria.ingress,mensageria.recipients,mensageria.group_catalog; update mensageria.connection_state set worker_id=null,lease_until=null,status='offline',pairing_request_id=null,pairing_completed_id=null;");}
async function connected(){const w=randomUUID();await repo.lease(w);await repo.state(w,'connected');return w;}

test('grupo exige JID de grupo e destino exclusivo; telefone segue compativel',()=>{
 assert.equal(input().phone,null); assert.equal(input().group_id,groupId);
 assert.throws(()=>input({group_id:'123@c.us'}),/invalid_group_id/);
 assert.throws(()=>input({group_id:'../../dados'}),/invalid_group_id/);
 assert.throws(()=>input({phone:'+5511900000000'}),/invalid_input/);
 assert.throws(()=>input({target_type:'channel'}),/invalid_input/);
 const phone=recipientInput({name:'Pessoa',phone:'+55 11 90000-0000',audience:'1',events:['health.water_progress']});
 assert.equal(phone.target_type,'phone'); assert.equal(phone.group_id,null);
});

test('catalogo guarda somente id e nome e ignora privados/canais/IDs invalidos',()=>{
 const result=catalogGroups([{isGroup:true,id:{_serialized:groupId},name:'Grupo',lastMessage:{body:'segredo'},participants:['privado']},{isGroup:false,id:{_serialized:'123@c.us'},name:'Pessoa'},{isGroup:true,id:{_serialized:'bad@g.us'},name:'Ruim'}]);
 assert.deepEqual(result,[{id:groupId,name:'Grupo'}]);
});

test('catalogo exige lease e conexao corrente; nao aceita grupo arbitrario ou sessao antiga',async()=>{
 await reset(); await assert.rejects(repo.saveRecipient(input()),/group_not_available/);
 const first=await connected(); await repo.syncGroups(first,[{id:groupId,name:'Grupo'}]);
 assert.deepEqual(await repo.groups(),[{id:groupId,name:'Grupo'}]);
 await assert.rejects(repo.syncGroups(randomUUID(),[]),/worker_lease_lost/);
 await repo.saveRecipient(input()); await repo.saveRecipient(input({name:'Renomeado'}));
 assert.equal((await repo.recipients()).length,1);
 await assert.rejects(repo.saveRecipient(input({group_id:'999@g.us'})),/group_not_available/);
 await db.exec("update mensageria.connection_state set lease_until=now()-interval '1 second'");
 assert.deepEqual(await repo.groups(),[]);
 const second=await connected(); assert.notEqual(first,second); assert.deepEqual(await repo.groups(),[]);
 await assert.rejects(repo.saveRecipient(input()),/group_not_available/);
 await repo.syncGroups(second,[{id:groupId,name:'Novo remetente'}]);
 await repo.requestPairingReset(); assert.deepEqual(await repo.groups(),[]);
 await assert.rejects(repo.saveRecipient(input()),/group_not_available/);
});

test('fila permite grupo e telefone por perfil; filtro e dedupe continuam iguais',async()=>{
 await reset(); const w=await connected(); await repo.syncGroups(w,[{id:groupId,name:'Grupo'}]);
 await repo.saveRecipient(input()); await repo.saveRecipient(input({audience:'2'}));
 await repo.saveRecipient(recipientInput({name:'Pessoa',phone:'+5511900000000',audience:'1',events:['health.water_progress']}));
 const event=alertInput({source:'superapp',audience:'1',event_type:'health.water_progress',idempotency_key:'grupo-teste',title:'Teste',message:'Nao enviar'});
 assert.equal((await repo.enqueue(event)).jobs.length,2);
 assert.equal((await repo.enqueue(event)).duplicate,true);
 const claimed=await repo.claim(w);assert.ok(['group','phone'].includes(claimed.target_type));
 assert.equal((await db.query('select * from mensageria.deliveries')).rows.length,2);
});

test('worker valida grupo ao vivo, permissao e catalogo antes de obter destino',async()=>{
 let lookups=0; const client={getChatById:async id=>{lookups++;return {isGroup:true,isReadOnly:false,id:{_serialized:id}};},getNumberId:async()=>({_serialized:'5511900000000@c.us'})};
 const list={groups:async()=>[{id:groupId,name:'Grupo'}]};
 assert.equal(await recipientAddress(client,list,input()),groupId);
 assert.equal(await recipientAddress(client,list,{phone:'+5511900000000'}),'5511900000000@c.us');
 await assert.rejects(recipientAddress(client,{groups:async()=>[]},input()),/group_unavailable/); assert.equal(lookups,1);
 await assert.rejects(recipientAddress({...client,getChatById:async()=>({isGroup:false})},list,input()),/group_unavailable/);
 await assert.rejects(recipientAddress({...client,getChatById:async()=>({isGroup:true,isReadOnly:true,id:{_serialized:groupId}})},list,input()),/group_read_only/);
 await assert.rejects(recipientAddress({...client,getChatById:async()=>{throw Error('private detail');}},list,input()),/group_unavailable/);
});

test('consulta de metadados tem prazo e nao bloqueia indefinidamente os envios',async()=>{
 await assert.rejects(metadataLookup(()=>new Promise(()=>{}),5),/group_lookup_timeout/);
 assert.equal(await metadataLookup(()=>Promise.resolve('ok'),100),'ok');
});

test('API grupos exige cookie admin e retorna somente metadados da conexao ativa',async()=>{
 await reset(); const w=await connected(); await repo.syncGroups(w,[{id:groupId,name:'Grupo'}]);
 const env={APP_ORIGIN:'https://example.test',ADMIN_TOKEN:'a'.repeat(64),INTEGRATION_TOKEN:'b'.repeat(64),SESSION_ENCRYPTION_KEY:'c'.repeat(64)};
 const server=http.createServer(createHandler({repository:repo,env})); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/api/control?action=groups';
 try{
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+env.INTEGRATION_TOKEN}})).status,401);
  const res=await fetch(url,{headers:{Cookie:'wm_session='+makeSession(env.ADMIN_TOKEN)}});
  assert.equal(res.status,200);assert.deepEqual(await res.json(),{groups:[{id:groupId,name:'Grupo'}]});
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('migration003 idempotente e rollback recusa perder destinatarios grupo',async()=>{
 await reset();await repo.syncGroups(await connected(),[{id:groupId,name:'Grupo'}]);await repo.saveRecipient(input());
 const up=await readFile(new URL('../migrations/003_group_recipients.sql',import.meta.url),'utf8');
 const down=await readFile(new URL('../migrations/003_group_recipients_rollback.sql',import.meta.url),'utf8');
 await db.exec(up);
 await assert.rejects(db.exec(down),/group_recipients_exist/);await db.exec('rollback');
 assert.equal((await repo.recipients()).length,1);
 await reset();await db.exec(down);await db.exec(up);
 const rls=await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='mensageria' and c.relname='group_catalog'");assert.equal(rls.rows[0].relrowsecurity,true);
});
