export async function metadataLookup(operation, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('group_lookup_timeout')), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
export function catalogGroups(chats) {
  const groups = new Map();
  for (const chat of chats) {
    const id = chat.id?._serialized;
    if (chat.isGroup && /^[0-9]+(-[0-9]+)?@g\.us$/.test(id || '') && id.length<=100) {
      groups.set(id, { id, name: String(chat.name || 'Grupo sem nome').slice(0,200) });
    }
  }
  return [...groups.values()];
}
export async function recipientAddress(client, repo, recipient) {
  if (recipient.target_type !== 'group') {
    const number = await client.getNumberId(recipient.phone.slice(1));
    if (!number) throw new Error('number_not_registered');
    return number._serialized;
  }
  if (!(await repo.groups()).some(g => g.id === recipient.group_id)) throw new Error('group_unavailable');
  let chat;
  try { chat = await metadataLookup(() => client.getChatById(recipient.group_id)); }
  catch (error) { throw new Error(error.message === 'group_lookup_timeout' ? 'group_lookup_timeout' : 'group_unavailable'); }
  if (!chat?.isGroup || chat.id?._serialized !== recipient.group_id) throw new Error('group_unavailable');
  if (chat.isReadOnly) throw new Error('group_read_only');
  return recipient.group_id;
}

// Executado no contexto do Chromium: somente metadados locais, sem serializar conversas.
export function readGroupCollections() {
  const collections = window.require('WAWebCollections');
  const result = new Map();
  let available = false;
  for (const collection of [collections.Chat, collections.GroupMetadata, collections.WAWebGroupMetadataCollection]) {
    if (!collection || typeof collection.getModelsArray !== 'function') continue;
    let models;
    try { models = collection.getModelsArray(); } catch { continue; }
    if (!Array.isArray(models)) continue;
    available = true;
    for (const model of models) {
      const id = typeof model.id === 'string' ? model.id : model.id?._serialized;
      if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(id || '') || id.length>100) continue;
      const name = model.formattedTitle || model.name || model.subject || model.groupMetadata?.subject;
      if (!result.has(id) || (name && result.get(id).name === 'Grupo sem nome')) result.set(id,{id,name:String(name || 'Grupo sem nome').slice(0,200)});
    }
  }
  if (!available) throw new Error('group_catalog_unavailable');
  return [...result.values()];
}
export async function discoverGroups(client) {
  try {
    const groups = await metadataLookup(() => client.pupPage.evaluate(readGroupCollections));
    if (!Array.isArray(groups)) throw new Error('group_catalog_unavailable');
    return groups.map(g => ({id:g.id,name:g.name}));
  } catch (error) {
    throw new Error(error.message === 'group_lookup_timeout' ? 'group_lookup_timeout' : 'group_catalog_unavailable');
  }
}
export function groupCatalogError(error) {
  return ['group_lookup_timeout','group_catalog_unavailable'].includes(error?.message) ? error.message : 'group_catalog_failed';
}
