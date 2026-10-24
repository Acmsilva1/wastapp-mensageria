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
