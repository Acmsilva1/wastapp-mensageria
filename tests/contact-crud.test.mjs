import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {Repository} from '../lib/repository.mjs';
import {DemoRepository} from '../lib/demo-repository.mjs';
import {recipientInput,alertInput} from '../lib/domain.mjs';
import {createHandler} from '../lib/http-handler.mjs';
import {makeSession} from '../lib/crypto.mjs';
const input=recipientInput({name:'Contato de teste',phone:'+5511900000000',audience:'1',events:['health.diet_menu'],enabled:true});
const alert=key=>alertInput({source:'superapp',event_type:'health.diet_menu',audience:'1',title:'Teste',message:'Não envia mensagem real.',idempotency_key:key});
for(const mode of ['volume','sql'])test(mode+': CRUD exclui da lista sem apagar historico, cancela pendentes e exige novo cadastro para restaurar',async t=>{
 let db,folder,repo;
 if(mode==='sql'){
  db=new PGlite();for(const file of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','007_interaction_permissions.sql','008_recipient_archive.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});t.after(()=>db.close());
 }else{folder=await mkdtemp(path.join(tmpdir(),'contacts-'));repo=await VolumeRepository.open(folder);t.after(()=>rm(folder,{recursive:true,force:true}));}
 const worker=randomUUID();await repo.lease(worker);const first=await repo.saveRecipient(input);const edited=await repo.saveRecipient({...input,name:'Nome atualizado'});assert.equal(first.id,edited.id);assert.equal((await repo.recipients())[0].name,'Nome atualizado');
 await repo.enqueue(alert('history'));const old=await repo.claim(worker);await repo.finish(worker,old.id,'sent',null,'test-id');
 const pending=await repo.enqueue(alert('pending'));await repo.deleteRecipient(first.id);await repo.deleteRecipient(first.id);
 assert.equal((await repo.recipients()).length,0);assert.equal((await repo.snapshot()).recipients.length,0);await assert.rejects(repo.toggleRecipient(first.id,true),/recipient_not_found/);await assert.rejects(repo.enqueue(alert('blocked')),/no_authorized_recipients/);
 const rows=mode==='sql'?(await db.query('select id,status,error_code from mensageria.deliveries')).rows:(await repo.read()).deliveries;
 assert.equal(rows.find(r=>r.id===old.id).status,'sent');assert.equal(rows.find(r=>r.id===pending.jobs[0].id).status,'cancelled');assert.equal(rows.find(r=>r.id===pending.jobs[0].id).error_code,'recipient_deleted');
 const restored=await repo.saveRecipient({...input,name:'Novo cadastro'});assert.equal(restored.id,first.id);assert.equal((await repo.recipients()).length,1);assert.equal((await repo.enqueue(alert('restored'))).jobs.length,1);
});
test('demo cria edita exclui e restaura sem qualquer integracao externa',async()=>{
 const repo=new DemoRepository(),contact=await repo.saveRecipient(input);await repo.saveRecipient({...input,name:'Editado'});assert.equal(repo.rows.find(r=>r.id===contact.id).name,'Editado');await repo.deleteRecipient(contact.id);assert.equal((await repo.snapshot()).recipients.some(r=>r.id===contact.id),false);await assert.rejects(repo.toggleRecipient(contact.id,true),/recipient_not_found/);await repo.saveRecipient(input);assert.equal((await repo.snapshot()).recipients.some(r=>r.id===contact.id),true);
});
test('API de exclusao exige sessao, origem e confirmacao explicita',async t=>{
 const folder=await mkdtemp(path.join(tmpdir(),'contacts-api-'));t.after(()=>rm(folder,{recursive:true,force:true}));const repo=await VolumeRepository.open(folder),r=await repo.saveRecipient(input);
 const env={APP_ORIGIN:'https://app.test',ADMIN_TOKEN:'admin-token-for-isolated-tests-only-123456',INTEGRATION_TOKEN:'integration-token-for-isolated-tests-only-123456'};
 const server=http.createServer(createHandler({repository:repo,env}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/api/control?action=recipient-delete';
 const call=(body,{cookie=makeSession(env.ADMIN_TOKEN),origin=env.APP_ORIGIN}={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Request':'1',Origin:origin,Cookie:'wm_session='+cookie},body:JSON.stringify(body)});
 const body={id:r.id,confirm:'delete_recipient'};
 assert.equal((await call(body,{cookie:''})).status,401);assert.equal((await call(body,{origin:'https://attacker.test'})).status,403);assert.equal((await call({id:r.id})).status,400);assert.equal((await repo.recipients()).length,1);
 assert.equal((await call(body)).status,200);assert.equal((await repo.recipients()).length,0);
});
