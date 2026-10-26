import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {serializedId,installSerializedIdCompatibility} from '../worker/serialized-id-compat.mjs';
import {catalogGroups,recipientAddress} from '../worker/group-target.mjs';
const require=createRequire(import.meta.url);
const {Client,Poll}=require('whatsapp-web.js');
const {LoadUtils}=require('whatsapp-web.js/src/util/Injected/Utils.js');

test('SDK e Utils reais: MsgKey $1 causava retorno vazio depois de enviar; compat retorna ID sem reenvio',async()=>{
 const prior=globalThis.window;let sends=0,counter=0,sendGate=null;const messages=new Map();
 class MsgKey {
  constructor(options){this.fromMe=true;this.remote=options.to;this.id=options.id;this.$1=`true_${options.to._serialized}_${options.id}`;}
  toString(){return this.$1;}
  static async newId(){return `FAKE-${++counter}`;}
 }
 const chat={id:{_serialized:'5511900000000@c.us',isLid:()=>false,isGroup:()=>false,isStatus:()=>false}};
 const modules={
  WAWebChatGetters:{getIsNewsletter:()=>false,getIsBroadcast:()=>false},WALinkify:{findLink:()=>null,findLinks:()=>[]},
  WAWebUserPrefsMeUser:{getMaybeMeLidUser:()=>({$1:'123@lid'}),getMaybeMePnUser:()=>({_serialized:'5511888888888@c.us'})},
  WAWebMsgKey:MsgKey,WAWebWidFactory:{createWid:id=>({_serialized:id})},
  WAWebGetEphemeralFieldsMsgActionsUtils:{getEphemeralFields:()=>({})},
  WAWebStreamModel:{Stream:{markAvailable(){},markUnavailable(){}}},WAWebUpdateUnreadChatAction:{sendSeen:async()=>{}},
  WAWebCollections:{Chat:{get:()=>chat},Msg:{get:key=>messages.get(key)}},
  WAWebSendMsgChatAction:{addAndSendMsgToChat(_chat,data){
    sends++;const model={...data,serialize(){return {...data,id:{...data.id}};}};
    messages.set(data.id.toString(),model);return [Promise.resolve(model),sendGate || Promise.resolve({})];
  }}
 };
 try {
  globalThis.window={require:name=>{if(!modules[name])throw new Error(`Missing stub ${name}`);return modules[name];},crypto:globalThis.crypto};
  LoadUtils();const client={pupPage:{evaluate:(callback,...args)=>callback(...args)}};
  const missing=await Client.prototype.sendMessage.call(client,chat.id._serialized,'ficticio');
  assert.equal(missing,undefined);assert.equal(sends,1,'o envio ocorreu apesar de retorno indefinido');
  installSerializedIdCompatibility();const wrapped=window.WWebJS.getMessageModel;
  installSerializedIdCompatibility();assert.equal(window.WWebJS.getMessageModel,wrapped,'reinjecao idempotente');
  const message=await Client.prototype.sendMessage.call(client,chat.id._serialized,'ficticio');
  assert.equal(sends,2,'uma unica chamada addAndSend para cada envio, sem retry');
  assert.equal(message.id._serialized,message.id.$1);
  assert.equal(message.to,'5511900000000@c.us');
  const poll=await Client.prototype.sendMessage.call(client,chat.id._serialized,new Poll('Quanto bebeu?',['100 ml','200 ml'],{allowMultipleAnswers:false}));
  assert.equal(sends,3);assert.equal(poll.id._serialized,poll.id.$1);assert.equal(poll.type,'poll_creation');
  assert.equal(poll._data.pollSelectableOptionsCount,1);
  let accept,reject,completed=false;sendGate=new Promise((resolve,rejector)=>{accept=resolve;reject=rejector;});
  const waiting=Client.prototype.sendMessage.call(client,chat.id._serialized,'ficticio',{waitUntilMsgSent:true}).then(value=>{completed=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false,'modelo local nao basta enquanto o envio aguarda aceitacao');
  accept({});assert.ok((await waiting).id._serialized);assert.equal(sends,4);
  sendGate=new Promise((_resolve,rejector)=>{reject=rejector;});
  const failed=Client.prototype.sendMessage.call(client,chat.id._serialized,'ficticio',{waitUntilMsgSent:true});
  const rejection=assert.rejects(failed,/send rejected/);reject(new Error('send rejected'));await rejection;assert.equal(sends,5,'rejeicao nao causa reenvio');
  const legacy=new MsgKey({to:chat.id,id:'old'});legacy._serialized='old-value';legacy._serialized='new-value';
  assert.equal(legacy._serialized,'new-value');assert.equal(Object.getOwnPropertyDescriptor(legacy,'_serialized').enumerable,true);
 } finally {if(prior===undefined)delete globalThis.window;else globalThis.window=prior;}
});

test('compat preserva prototipo legado existente e IDs locais aceitam ambos formatos',()=>{
 const prior=globalThis.window;class OldKey{};Object.defineProperty(OldKey.prototype,'_serialized',{get(){return 'legacy';},configurable:true});
 const descriptor=Object.getOwnPropertyDescriptor(OldKey.prototype,'_serialized');
 try {globalThis.window={require:()=>OldKey,WWebJS:{getMessageModel:value=>value}};installSerializedIdCompatibility();
 assert.deepEqual(Object.getOwnPropertyDescriptor(OldKey.prototype,'_serialized'),descriptor);
 assert.equal(serializedId({_serialized:'old',$1:'new'}),'old');assert.equal(serializedId({$1:'new'}),'new');assert.equal(serializedId(undefined),null);
 } finally {if(prior===undefined)delete globalThis.window;else globalThis.window=prior;}
});

test('destinos e catalogos aceitam IDs $1 sem alterar filtros de grupo',async()=>{
 const group='120363123456789@g.us';
 assert.deepEqual(catalogGroups([{id:{$1:group},isGroup:true,name:'Grupo'}]),[{id:group,name:'Grupo'}]);
 assert.equal(await recipientAddress({getNumberId:async()=>({$1:'5511900000000@c.us'})},{},{target_type:'phone',phone:'+5511900000000'}),'5511900000000@c.us');
});
