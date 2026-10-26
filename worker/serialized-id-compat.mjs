// Newer WA Web MsgKey models expose $1; keep the older SDK contract at our boundary.
export function serializedId(value) {
  if (typeof value==='string') return value;
  if (typeof value?._serialized==='string') return value._serialized;
  return typeof value?.$1==='string' ? value.$1 : null;
}

// Runs inside Chromium. No sends, authentication changes, retries or message logging.
export function installSerializedIdCompatibility() {
  const MsgKey=window.require('WAWebMsgKey');
  const proto=MsgKey?.prototype;
  if (!proto || proto===Object.prototype) throw new Error('message_key_compat_unavailable');
  if (!('_serialized' in proto)) {
    Object.defineProperty(proto,'_serialized',{
      configurable:true,
      get() {
        if (typeof this.$1==='string') return this.$1;
        const value=this.toString();
        return typeof value==='string' && value!=='[object Object]' ? value : undefined;
      },
      // Older strict-mode constructors still assign this field. Preserve own-property behavior.
      set(value) {Object.defineProperty(this,'_serialized',{value,writable:true,enumerable:true,configurable:true});}
    });
  }
  const sdk=window.WWebJS;
  if(typeof sdk?.getMessageModel!=='function') throw new Error('message_model_compat_unavailable');
  if(!sdk.getMessageModel.mensageriaSerializedCompat) {
    const original=sdk.getMessageModel;
    const id=value=>typeof value==='string'?value:typeof value?._serialized==='string'?value._serialized:typeof value?.$1==='string'?value.$1:null;
    const wrapped=function(message) {
      const model=original.call(this,message);
      const key=id(model?.id) || id(message?.id);
      if(model?.id && key) model.id={...model.id,_serialized:key};
      if(model?.id && typeof model.id.remote==='object') model.id.remote=id(model.id.remote);
      if(model?.id && !model.id.remote) model.id.remote=id(message?.id?.remote);
      for(const field of ['from','to','author']) {
        const value=id(model?.[field]) || id(message?.[field]);
        if(value) model[field]=value;
      }
      return model;
    };
    Object.defineProperty(wrapped,'mensageriaSerializedCompat',{value:true});
    sdk.getMessageModel=wrapped;
  }
  return {messageKey:true,messageModel:true};
}
