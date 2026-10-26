import {serializedId} from './serialized-id-compat.mjs';
import {MAX_AUDIO_BYTES} from './purchase-groq.mjs';

// Runs in the worker's authenticated Chromium. Keys and media URLs stay there.
export async function downloadAudioInPage({id,maxBytes}) {
 try {
  const store=window.require('WAWebCollections');
  const message=store.Msg.get(id) || (await store.Msg.getMessagesById([id]))?.messages?.[0];
  const mime=String(message?.mimetype || '').toLowerCase().split(';')[0].trim();
  if(!message || !['ptt','audio'].includes(message.type) || !['audio/ogg','audio/wav','audio/x-wav','audio/mp4','audio/m4a','audio/x-m4a'].includes(mime)
    || !Number.isFinite(Number(message.size)) || Number(message.size)<1 || Number(message.size)>maxBytes
    || !Number.isFinite(Number(message.duration)) || Number(message.duration)<=0 || Number(message.duration)>60
    || !message.mediaData || message.mediaData.mediaStage==='REUPLOADING')throw new Error('purchase_audio_download_failed');
  if(message.mediaData.mediaStage!=='RESOLVED')await message.downloadMedia({downloadEvenIfExpensive:true,rmrReason:1});
  if(message.mediaData.mediaStage!=='RESOLVED')throw new Error('purchase_audio_download_failed');
  const downloadQpl={addAnnotations(){return this;},addPoint(){return this;}};
  // whatsapp-web.js 1.34.7 omits mimetype; current WA rejects ptt as octet-stream.
  const data=await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
   directPath:message.directPath,encFilehash:message.encFilehash,filehash:message.filehash,
   mediaKey:message.mediaKey,mediaKeyTimestamp:message.mediaKeyTimestamp,type:message.type,mimetype:message.mimetype,
   signal:AbortSignal.timeout(12000),downloadQpl
  });
  if(!data || !Number.isSafeInteger(data.byteLength) || data.byteLength<1 || data.byteLength>maxBytes)throw new Error('purchase_audio_download_failed');
  return {data:await window.WWebJS.arrayBufferToBase64Async(data),mimetype:message.mimetype};
 }catch {throw new Error('purchase_audio_download_failed');}
}

export function downloadPurchaseAudio(client,message) {
 if(!client.pupPage?.evaluate)return message.downloadMedia();
 return client.pupPage.evaluate(downloadAudioInPage,{id:serializedId(message.id),maxBytes:MAX_AUDIO_BYTES});
}
