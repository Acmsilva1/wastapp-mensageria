import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {Repository} from '../lib/repository.mjs';
import {VolumeRepository} from '../lib/volume-repository.mjs';
import {recipientInput,recipientPermits,interactionVersion} from '../lib/domain.mjs';
import {createHandler} from '../lib/http-handler.mjs';
const token='integration-test-only-at-least-32-characters';
const input=(extra={})=>recipientInput({name:'Pessoa',phone:'+5511900000000',audience:'1',events:[],permissions:['purchases.record'],...extra});

test('Água unifica receber e registrar; compras seguem separadas e grupos não concedem escrita',()=>{
 const water=input({events:['health.water_progress'],permissions:[]});
 assert.equal(recipientPermits(water,'water.record'),true);assert.equal(recipientPermits(water,'purchases.record'),false);
 assert.equal(recipientPermits({enabled:true,target_type:'phone',events:['health.water_progress'],permissions:[]},'water.record'),true);
 assert.equal(recipientPermits({enabled:true,target_type:'phone',events:[],permissions:['water.record']},'water.record'),false);
 assert.equal(recipientPermits({enabled:true,target_type:'group',events:['health.water_progress'],permissions:[]},'water.record'),false);
 assert.equal(recipientPermits(input(),'purchases.record'),true);
 assert.equal(recipientPermits({...input(),enabled:false},'purchases.record'),false);
 assert.throws(()=>input({permissions:['water.record']}),/invalid_input/);
 for(const extra of [{events:[],permissions:[]},{permissions:['admin']},{permissions:'purchases.record'},{phone:null,target_type:'group',group_id:'123@g.us'}])assert.throws(()=>input(extra),/invalid_input/);
});

for(const mode of ['sql','volume'])test(`${mode}: ACL autentica serviço, isola pessoa, revoga e rejeita versões antigas e vínculos ambíguos`,async()=>{
 let repo,db,dir,server;
 try{
  if(mode==='sql'){
   db=new PGlite();
   for(const file of ['001_mensageria.sql','002_pairing_reset.sql','003_group_recipients.sql','007_interaction_permissions.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
   // Safe rerun does not regrant revoked permissions.
   await db.exec(await readFile(new URL('../migrations/007_interaction_permissions.sql',import.meta.url),'utf8'));
   repo=new Repository({query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})});
  }else{dir=await mkdtemp(path.join(tmpdir(),'interaction-permissions-'));repo=await VolumeRepository.open(dir);}
  const row=await repo.saveRecipient(input());
  assert.deepEqual((await repo.recipients())[0].permissions,['purchases.record']);
  const handler=createHandler({repository:repo,env:{APP_ORIGIN:'https://panel.example',ADMIN_TOKEN:'admin-test-only-at-least-32-characters',INTEGRATION_TOKEN:token}});
  server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/control?action=interaction-authorize`;
  const body={sender_phone:row.phone,permission:'purchases.record',authorization_id:row.id,authorization_version:interactionVersion(row)};
  const request=(changes={},secret=token)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({...body,...changes})});
  assert.equal((await request({},'wrong')).status,401);
  const accepted=await request();assert.equal(accepted.status,200);assert.equal((await accepted.json()).authorized,true);
  assert.equal((await request({sender_phone:'+5511999999999'})).status,403);
  assert.equal((await request({authorization_version:'a'.repeat(64)})).status,403);
  assert.equal((await request({permission:'water.record'})).status,400);
  await repo.toggleRecipient(row.id,false);assert.equal((await request()).status,403);
  await repo.toggleRecipient(row.id,true);assert.equal((await request()).status,403,'old grant stays invalid after reactivation');
  const current=(await repo.recipients())[0];body.authorization_version=interactionVersion(current);assert.equal((await request()).status,200);
  await repo.saveRecipient(input({audience:'2'}));assert.equal((await request()).status,403,'ambiguous purchase destination is denied');
  if(mode==='sql'){
   await assert.rejects(db.exec(await readFile(new URL('../migrations/007_interaction_permissions_rollback.sql',import.meta.url),'utf8')),/interaction_permissions_exist/);
   await db.exec('rollback');
  }
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(db)await db.close();if(dir)await rm(dir,{recursive:true,force:true});
 }
});
