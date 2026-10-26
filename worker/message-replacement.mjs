import {serializedId} from './serialized-id-compat.mjs';
import {metadataLookup} from './group-target.mjs';

const individual=address=>typeof address==='string' && /^\d{5,20}@(c\.us|lid)$/.test(address);
export const replacementScope=(job,address)=>individual(address)?JSON.stringify([address,job.audience,job.event_type]):null;

// Self-contained Chromium adapter. Local deletion is allowed ONLY in the connected account's self-chat.
export async function revokeOwnMessageInPage(messageId,address) {
  const id=value=>typeof value==='string'?value:value?._serialized || value?.$1;
  if(!/^\d{5,20}@(c\.us|lid)$/.test(address || '') || typeof messageId!=='string')return {ok:false,code:'delete_scope_invalid',terminal:true};
  const store=window.require('WAWebCollections');
  const message=store.Msg.get(messageId) || (await store.Msg.getMessagesById([messageId]))?.messages?.[0];
  if(!message)return {ok:false,code:'delete_message_unavailable',terminal:true};
  if(message.id?.fromMe!==true || id(message.id)!==messageId)return {ok:false,code:'delete_not_bot_message',terminal:true};
  if(id(message.id.remote)!==address)return {ok:false,code:'delete_wrong_conversation',terminal:true};
  if(message.type==='revoked')return {ok:true};
  let self=false;
  try {
    const me=window.require('WAWebUserPrefsMeUser');
    self=[id(me.getMaybeMePnUser()),id(me.getMaybeMeLidUser())].some(value=>value && value===address);
  } catch {} // No account identity => never authorize local deletion.
  if(self) {
    const chat=store.Chat.get(message.id.remote) || await store.Chat.find(message.id.remote);
    if(!chat || id(chat.id)!==address)return {ok:false,code:'delete_chat_unavailable',terminal:false};
    const {Cmd}=window.require('WAWebCmd');
    if(typeof Cmd?.sendDeleteMsgs!=='function')return {ok:false,code:'delete_capability_unavailable',terminal:false};
    if(window.WWebJS.compareWwebVersions(window.Debug.VERSION,'>=','2.3000.0')) {
      await Cmd.sendDeleteMsgs(chat,{list:[message],type:'message'},true);
    } else {
      await Cmd.sendDeleteMsgs(chat,[message],true);
    }
    return {ok:true,mode:'self'};
  }
  const capability=window.require('WAWebMsgActionCapability');
  if(typeof capability?.canSenderRevokeMsg!=='function')return {ok:false,code:'delete_capability_unavailable',terminal:false};
  if(!await capability.canSenderRevokeMsg(message))return {ok:false,code:'delete_not_revocable',terminal:true};
  const chat=store.Chat.get(message.id.remote) || await store.Chat.find(message.id.remote);
  if(!chat || id(chat.id)!==address)return {ok:false,code:'delete_chat_unavailable',terminal:false};
  const {Cmd}=window.require('WAWebCmd');
  if(typeof Cmd?.sendRevokeMsgs!=='function')return {ok:false,code:'delete_capability_unavailable',terminal:false};
  if(window.WWebJS.compareWwebVersions(window.Debug.VERSION,'>=','2.3000.0')) {
    await Cmd.sendRevokeMsgs(chat,{list:[message],type:'message'},{clearMedia:true});
  } else {
    await Cmd.sendRevokeMsgs(chat,[message],{clearMedia:true,type:'Sender'});
  }
  return {ok:true,mode:'everyone'};
}
export async function revokeBotMessage(client,address,messageId) {
  try {
    const message=await metadataLookup(()=>client.getMessageById(messageId),10000);
    if(!message)return {ok:false,code:'delete_message_unavailable',terminal:true};
    if(message.fromMe!==true || serializedId(message.id)!==messageId)return {ok:false,code:'delete_not_bot_message',terminal:true};
    if(serializedId(message.to)!==address && serializedId(message.id?.remote)!==address)return {ok:false,code:'delete_wrong_conversation',terminal:true};
    return await metadataLookup(()=>client.pupPage.evaluate(revokeOwnMessageInPage,messageId,address),10000);
  } catch(error) {
    return {ok:false,code:error?.message==='group_lookup_timeout'?'delete_timeout':'delete_failed',terminal:false};
  }
}
export function createMessageReplacement({repo,worker,revoke}) {
  const locks=new Map();
  function withScope(job,address,action) {
    const key=replacementScope(job,address);
    if(!key)return action();
    const previous=locks.get(key) || Promise.resolve();
    const task=previous.catch(()=>{}).then(action);
    locks.set(key,task);
    return task.finally(()=>{if(locks.get(key)===task)locks.delete(key);});
  }
  return {
    withScope,
    async begin(job,address) {if(replacementScope(job,address))await repo.beginReplacement(worker,job.id,address);},
    async complete(job,address,ids,expected=1) {
      if(ids.length!==expected || new Set(ids).size!==expected || ids.some(id=>typeof id!=='string' || !id))throw new Error('replacement_ids_missing');
      if(replacementScope(job,address))await repo.completeReplacement(worker,job.id,address,[...new Set(ids)]);
      else await repo.finish(worker,job.id,'sent',null,ids.at(-1));
    },
    async trackFeedback(job,address,message) {
      if(!replacementScope(job,address))return;
      if(job.replacement_address ? job.replacement_address!==address : job.status!=='sent' || job.water_address!==address)return;
      const id=serializedId(message?.id);
      if(!id)throw new Error('replacement_feedback_unconfirmed');
      await repo.appendReplacementMessage(worker,job.id,id,address,job.audience);
    },
    async cleanup() {
      let budget=10;
      for(const row of await repo.pendingReplacementDeletes()) {
        if(!budget)break;
        if(!replacementScope(row,row.replacement_address))continue;
        await withScope(row,row.replacement_address,async()=>{
          // Only IDs from a completed older set enter this queue. No chat scan or sends.
          for(const messageId of row.delete_pending_ids) {
            if(!budget)break;
            budget--;
            await repo.heartbeat(worker);
            const result=await revoke(row.replacement_address,messageId);
            await repo.settleReplacementDelete(worker,row.id,messageId,result.ok?null:result.code,Boolean(result.terminal));
            if(!result.ok)console.error(JSON.stringify({event:'replacement_delete_failed',code:result.code}));
            if(!result.ok && !result.terminal)break;
          }
        });
      }
    }
  };
}
