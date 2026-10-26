import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {AppError,interactionVersion} from './domain.mjs';

const DAY=86400000;
export function agentIdentity(value) {
 if(!value || typeof value.request_id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.request_id)
  || typeof value.project!=='string' || !value.project.trim() || value.project.length>120 || /[\x00-\x1f\x7f]/.test(value.project))throw new AppError(400,'invalid_agent_request');
 return {request_id:value.request_id.toLowerCase(),project:value.project.trim()};
}
async function locked(dir,fn) {
 const file=path.join(dir,'.agent-channel.lock'),token=`${Date.now()}:${randomUUID()}`;
 for(let n=0;n<200;n++) {
  let handle;
  try{handle=await open(file,'wx',0o600);}catch(e){
   if(e.code!=='EEXIST')throw e;
   try{if(Date.now()-(await stat(file)).mtimeMs>60000)await rm(file,{force:true});}catch{}
   await sleep(25);continue;
  }
  try{await handle.writeFile(token);return await fn();}
  finally{await handle.close();try{if(await readFile(file,'utf8')===token)await rm(file,{force:true});}catch{}}
 }
 throw new AppError(503,'agent_channel_busy');
}
const blank=()=>({version:2,owner_phone:null,next_id:1,requests:[],messages:[],notices:[]});
export class AgentInbox {
 constructor(dir,{now=()=>Date.now()}={}){this.dir=dir;this.file=path.join(dir,'agent-inbox.json');this.now=now;}
 static async open(dir,options){await mkdir(dir,{recursive:true,mode:0o700});return new AgentInbox(dir,options);}
 async change(fn){return locked(this.dir,async()=>{
  let state;
  try{const raw=await readFile(this.file,'utf8');if(Buffer.byteLength(raw)>600000)throw new Error('agent_state_size');state=JSON.parse(raw);}
  catch(e){if(e.code!=='ENOENT')throw e;state=blank();}
  // Never expose messages collected by the old, unscoped experimental inbox.
  if(state.version!==2)state=blank();
  if(!Number.isSafeInteger(state.next_id)||state.next_id<1||!Array.isArray(state.requests)||!Array.isArray(state.messages)||!Array.isArray(state.notices))throw new Error('agent_state_invalid');
  const now=this.now(),cutoff=now-DAY;
  state.requests=state.requests.filter(r=>r.created_at>=cutoff);
  for(const r of state.requests)if(r.status==='armed'&&r.expires_at<=now)r.status='expired';
  state.messages=state.messages.filter(m=>m.at>=cutoff&&state.requests.some(r=>r.request_id===m.request_id));
  state.notices=state.notices.filter(n=>n.at>now-3600000);
  const result=await fn(state);
  const payload=JSON.stringify(state);if(Buffer.byteLength(payload)>524288)throw new AppError(503,'agent_channel_full');
  const temp=`${this.file}.${randomUUID()}.tmp`;
  try{await writeFile(temp,payload,{mode:0o600});await rename(temp,this.file);}finally{await rm(temp,{force:true}).catch(()=>{});}
  return structuredClone(result);
 });}
 async setOwner(phone){if(!/^\+[1-9]\d{7,14}$/.test(phone || ''))throw new Error('agent_owner_invalid');return this.change(s=>{
  if(s.owner_phone&&s.owner_phone!==phone){s.requests=[];s.messages=[];s.notices=[];}
  s.owner_phone=phone;
 });}
 owner(){return this.change(s=>s.owner_phone);}
 async arm(input,recipient){const identity=agentIdentity(input);const ttl=Number(input.ttl_minutes ?? 60);if(!Number.isFinite(ttl))throw new AppError(400,'invalid_agent_request');
  return this.change(s=>{
   let r=s.requests.find(r=>r.request_id===identity.request_id);
   if(r){if(r.project!==identity.project||r.recipient_id!==recipient.id)throw new AppError(409,'agent_request_conflict');
    if(r.status!=='armed'||r.authorization_version!==interactionVersion(recipient))throw new AppError(410,'agent_request_closed');
   }else{
    if(s.requests.length>=100)throw new AppError(429,'agent_channel_full');
    const minutes=Math.min(240,Math.max(5,Math.round(ttl)));
    r={...identity,recipient_id:recipient.id,authorization_version:interactionVersion(recipient),created_at:this.now(),expires_at:this.now()+minutes*60000,ttl_minutes:minutes,status:'armed',bindings:[]};s.requests.push(r);
   }
   return {ok:true,...identity,audience:recipient.audience,expires_at:new Date(r.expires_at).toISOString(),ttl_minutes:r.ttl_minutes};
  });
 }
 verify(identity,recipient){identity=agentIdentity(identity);return this.change(s=>{const r=s.requests.find(r=>r.request_id===identity.request_id);
  if(!r||r.project!==identity.project)throw new AppError(404,'agent_request_not_found');
  if(r.status!=='armed'||r.recipient_id!==recipient.id||r.authorization_version!==interactionVersion(recipient))throw new AppError(410,'agent_request_closed');return true;
 });}
 notice(key,project){return this.change(s=>{const old=s.notices.find(n=>n.key===key);if(old){if(old.project!==project)throw new AppError(409,'agent_request_conflict');return;}
  if(s.notices.filter(n=>n.project===project).length>=10)throw new AppError(429,'agent_notice_rate_limited');s.notices.push({key,project,at:this.now()});
 });}
 bind(identity,recipient,address,id){identity=agentIdentity(identity);return this.change(s=>{const r=s.requests.find(r=>r.request_id===identity.request_id&&r.project===identity.project);
  if(!r||r.status!=='armed'||r.recipient_id!==recipient.id||r.authorization_version!==interactionVersion(recipient))throw new AppError(410,'agent_request_closed');
  if(!r.bindings.some(b=>b.id===id)){if(r.bindings.length>=10)throw new AppError(429,'agent_channel_full');r.bindings.push({id,address,phone:recipient.phone});}return true;
 });}
 find({quoteId,requestId}){return this.change(s=>s.requests.find(r=>quoteId?r.bindings.some(b=>b.id===quoteId):r.request_id===requestId)||null);}
 record(identity,recipient,{text,message_id,address}){identity=agentIdentity(identity);if(typeof text!=='string'||!text.trim()||text.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))return false;
  return this.change(s=>{const r=s.requests.find(r=>r.request_id===identity.request_id&&r.project===identity.project);
   if(!r||r.status!=='armed'||!r.bindings.length||r.recipient_id!==recipient.id||r.authorization_version!==interactionVersion(recipient)||!r.bindings.some(b=>b.phone===address))return false;
   if(s.messages.some(m=>m.message_id===message_id))return false;
   if(s.messages.length>=200)throw new AppError(429,'agent_channel_full');
   s.messages.push({...identity,id:s.next_id++,text:text.trim(),message_id,at:this.now()});r.status='answered';return true;
  });
 }
 since(input,since=0,recipient){const identity=agentIdentity(input);if(!Number.isSafeInteger(since)||since<0)throw new AppError(400,'invalid_input');return this.change(s=>{
  const r=s.requests.find(r=>r.request_id===identity.request_id&&r.project===identity.project);if(!r)throw new AppError(404,'agent_request_not_found');
  if(!recipient||r.recipient_id!==recipient.id||r.authorization_version!==interactionVersion(recipient))throw new AppError(410,'agent_request_closed');
  return {ok:true,...identity,armed:r.status==='armed',expires_at:new Date(r.expires_at).toISOString(),messages:s.messages.filter(m=>m.request_id===r.request_id&&m.id>since).map(m=>({id:m.id,...identity,text:m.text,at:new Date(m.at).toISOString()}))};
 });}
 close(input){const identity=agentIdentity(input);return this.change(s=>{const r=s.requests.find(r=>r.request_id===identity.request_id&&r.project===identity.project);if(!r)throw new AppError(404,'agent_request_not_found');if(r.status==='armed')r.status='closed';return{ok:true,...identity,closed:true};});}
}
