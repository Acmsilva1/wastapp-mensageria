import {createAgentService} from '../lib/agent-channel.mjs';
import {actorPhone} from './water-replies.mjs';
import {serializedId} from './serialized-id-compat.mjs';
import {metadataLookup} from './group-target.mjs';
const command=/^\/agente\s+([a-f0-9-]{36})\s+([\s\S]+)$/i;
export function createAgentChannel({client,repo,dataPath,clock=()=>Date.now(),service=createAgentService({repository:repo,dataPath})}) {
 if(typeof repo.dataPath!=='string')return {ready:async()=>{},refresh:()=>{},cleanup:async()=>{},authorizeDelivery:async()=>false,bind:async()=>{},message:async m=>m?.type==='chat'&&/^\/agente(?:\s|$)/i.test(String(m.body||''))};
 let ownerPhone=null,initializing=null,lastAttempt=0;
 function initializeOwner(){
  if(ownerPhone)return Promise.resolve();if(initializing)return initializing;lastAttempt=clock();
  initializing=(async()=>{const phone=await actorPhone(client,client.info?.wid);if(!phone)throw new Error('agent_owner_unavailable');await(await service.store()).setOwner(phone);ownerPhone=phone;})().finally(()=>{initializing=null;});return initializing;
 }
 return {...service,
  async authorizeDelivery(job,r){await initializeOwner();return Boolean(ownerPhone&&r.phone===ownerPhone)&&service.authorizeDelivery(job,r);},
  ready:initializeOwner,
  refresh(){if(!ownerPhone&&!initializing&&clock()-lastAttempt>=30000)void initializeOwner().catch(()=>console.error('agent_channel_owner_unavailable'));},
  async message(message){
   if(!message||message.type!=='chat')return false;
   const text=String(message.body||'').trim(),explicit=/^\/agente(?:\s|$)/i.test(text);let candidate=explicit;
   if(message.fromMe!==true||message.isForwarded||message.isGroupMsg||message.isStatus)return explicit;
   try{
    const address=serializedId(message.to),id=serializedId(message.id);
    if(!id||!/^\d+@(c\.us|lid)$/.test(address||'')||!Number.isFinite(message.timestamp)||Math.abs(Date.now()/1000-message.timestamp)>900)return explicit;
    const own=await actorPhone(client,client.info?.wid);if(!own||await actorPhone(client,address)!==own)return explicit;
    let quoteId=null;
    if(!explicit){
     if(!message.hasQuotedMsg)return false;
     const quote=await metadataLookup(()=>message.getQuotedMessage(),10000);
     if(quote?.fromMe!==true||!String(quote.body||'').startsWith('🦉 Agente'))return false;
     candidate=true;quoteId=serializedId(quote.id);
    }
    const parsed=explicit?command.exec(text):null;
    if(explicit&&!parsed)return true;
    const inbox=await service.store(),request=await inbox.find({quoteId,requestId:parsed?.[1].toLowerCase()});
    if(!request)return true;
    const r=await service.recipient();
    if(await repo.knownBotMessage(id))return true;
    await inbox.record(request,r,{text:explicit?parsed[2]:text,message_id:id,address:own});
    return true;
   }catch{console.error('agent_channel_processing_failed');return candidate;}
  }
 };
}
