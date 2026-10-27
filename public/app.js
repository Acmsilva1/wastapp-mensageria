const $ = selector => document.querySelector(selector);
const messages = {
  agent_channel_unavailable: 'O canal de projetos requer a mensageria no modo volume da VPS.',
  agent_private_only: 'Avisos de projetos são permitidos somente para números individuais.',
  invalid_group_id: 'Selecione um grupo válido da lista da conta conectada.',
  group_unavailable: 'O grupo não está mais disponível para a conta conectada.',
  group_read_only: 'A conta conectada não tem permissão para enviar mensagens nesse grupo.',
  database_auth_failed: 'O Supabase recusou o usuário ou a senha da DATABASE_URL. Confira também a codificação dos caracteres especiais.',
  database_schema_missing: 'As tabelas da mensageria não foram encontradas. Execute 001_mensageria.sql no mesmo banco da DATABASE_URL.',
  database_schema_outdated: 'O banco está com uma estrutura diferente. Execute as migrations 002_pairing_reset.sql e 003_group_recipients.sql no banco da mensageria.',
  database_permission_denied: 'O usuário PostgreSQL não tem permissão no schema mensageria.',
  database_tls_error: 'O certificado do banco não foi validado. Configure DATABASE_CA_CERT com a CA fornecida pelo Supabase.',
  database_host_not_found: 'O host da DATABASE_URL não foi encontrado. Confira a conexão do pooler no Supabase.',
  database_unreachable: 'Não foi possível alcançar o banco. Confira o host e a porta do Transaction Pooler.',
  database_timeout: 'A conexão com o banco excedeu o tempo limite. Confira o pooler e a disponibilidade do Supabase.',
  database_connection_reset: 'A conexão com o banco foi interrompida. Confira a disponibilidade do Supabase.',
  database_connection_limit: 'O banco atingiu o limite de conexões. Confira o pooler e as conexões em uso.',
  database_unavailable: 'O banco está temporariamente indisponível.',
  database_name_invalid: 'O nome do banco na DATABASE_URL não existe.',
  database_configuration_invalid: 'DATABASE_URL não foi configurada ou tem formato inválido.',
  encryption_key_invalid: 'SESSION_ENCRYPTION_KEY deve ter exatamente 64 caracteres hexadecimais.',
  demo_no_pairing: 'O pareamento real não está disponível na demonstração.', pairing_confirmation_required: 'Confirme o reinício do pareamento.',
  invalid_credentials: 'Chave de administração incorreta.', authentication_required: 'Entre novamente no painel.',
  configuration_required: 'Configure as variáveis de ambiente e o banco antes de entrar.', service_unavailable: 'Serviço indisponível. Confira a conexão com o banco e as migrations.',
  login_rate_limited: 'Muitas tentativas. Aguarde dez minutos.', invalid_input: 'Confira os campos e selecione ao menos um alerta ou uma permissão.',
  group_not_found: 'O grupo não está disponível na conta conectada. Atualize a lista e confira a participação da conta no grupo.',
  group_not_available: 'O grupo não está disponível na conta conectada. Atualize a lista de grupos.',
  group_catalog_unavailable: 'A lista de grupos ainda não está disponível. Aguarde o WhatsApp conectar e atualize a lista.',
  group_lookup_timeout: 'A consulta dos grupos excedeu o tempo limite. Atualize a lista novamente.',
  group_catalog_failed: 'Não foi possível consultar os grupos da conta conectada. Atualize a lista novamente.',
  group_catalog_stale: 'A lista de grupos está desatualizada. Atualize a lista antes de salvar.',
  group_connection_required: 'Conecte o WhatsApp antes de carregar os grupos.',
  group_invalid: 'Selecione um grupo válido da lista da conta conectada.',
  group_id_invalid: 'Selecione um grupo válido da lista da conta conectada.',
  phone_requires_country_code: 'Informe o número com +, DDI e DDD. Exemplo: +55 11 99999-9999.', origin_rejected: 'O endereço do painel difere do APP_ORIGIN configurado.'
};
const stateLabels = { restarting: 'Preparando novo QR', offline: 'Serviço offline', connecting: 'Conectando', qr: 'Escaneie o QR', authenticated: 'Finalizando conexão', connected: 'Conectado' };
const deliveryLabels = { pending: 'Na fila', sending: 'Enviando', sent: 'Enviado', failed: 'Falhou', uncertain: 'Sem confirmação', cancelled: 'Cancelado' };
const deliveryErrorLabels = { group_lookup_timeout: 'A consulta ao grupo excedeu o tempo limite antes do envio.', group_unavailable: 'Grupo indisponível: confira se a conta ainda participa dele.', group_read_only: 'Sem permissão para enviar nesse grupo.', recipient_unavailable: 'Destinatário indisponível.', recipient_not_registered: 'Número não encontrado no WhatsApp.', send_failed: 'Não foi possível concluir o envio.', send_timeout: 'O envio excedeu o tempo limite; confira a conversa antes de reenviar.' };
const logLabels = { group_catalog_failed: 'Não foi possível atualizar a lista de grupos da conta conectada', pairing_reset_completed: 'Sessão anterior removida; aguardando novo QR', worker_started: 'Serviço iniciado', worker_stopped: 'Serviço encerrado', qr_issued: 'QR Code renovado', authenticated: 'Pareamento aceito', connected: 'WhatsApp conectado', session_saved: 'Backup da sessão salvo', auth_failure: 'Falha na autenticação', disconnected: 'WhatsApp desconectado' };
let currentRecipients = [];
let groupCatalog = [];
let groupsLoading = false;
let groupsLoaded = false;
let editingRecipient = null;
let savingRecipient = false;
let formGeneration = 0;
let events = {};
let polling = false;
let loggedIn = false;
let lastSnapshot = '';
let toastTimer;
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
async function api(action, body) {
  const response = await fetch(`/api/control?action=${action}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && action !== 'login') showLogin(); throw new Error(messages[data.error] || 'Não foi possível concluir. Tente novamente.'); }
  return data;
}
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
const time = value => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
function showLogin() { loggedIn = false; groupCatalog = []; groupsLoaded = false; resetForm(); lastSnapshot = ''; $('#recipient-list').replaceChildren(); updateGroupOptions(); $('#login').hidden = false; $('#dashboard').hidden = true; $('#logout').hidden = true; $('#qr').removeAttribute('src'); }
function showDashboard(demo) { loggedIn = true; $('#login').hidden = true; $('#dashboard').hidden = false; $('#logout').hidden = demo; $('#demo-note').hidden = !demo; $('#environment').textContent = demo ? 'Demonstração local' : 'WhatsApp'; }
function renderRecipients(rows) {
  currentRecipients = rows;
  $('#recipient-count').textContent = String(rows.length);
  const container = $('#recipient-list'); container.replaceChildren();
  if (!rows.length) { container.append(element('p', 'Nenhum destinatário cadastrado.', 'empty')); return; }
  for (const r of rows) {
    const card = element('article', undefined, 'recipient');
    const head = element('div', undefined, 'recipient-head');
    head.append(element('strong', r.name), element('span', r.enabled ? 'Ativo' : 'Inativo', `pill ${r.enabled ? 'ok' : 'off'}`));
    card.append(head, element('div', r.target_type === 'group' ? 'Grupo do WhatsApp' : r.follow_session ? `Sessão (não recebe alertas de perfil)${r.phone ? ` · ${r.phone}` : ''}` : r.phone, 'recipient-phone'), element('div', `Ref.: ${r.audience}`, 'recipient-profile'));
    const tags = element('div', undefined, 'tags'); for (const type of r.events) tags.append(element('span', events[type] || type, 'tag')); if (r.permissions?.includes('purchases.record')) tags.append(element('span', 'Pode enviar compras', 'tag')); card.append(tags);
    const actions = element('div', undefined, 'recipient-actions');
    const edit = element('button', 'Editar', 'quiet'); edit.type = 'button'; edit.onclick = () => editRecipient(r);
    const toggle = element('button', r.enabled ? 'Desativar' : 'Ativar', 'quiet'); toggle.type = 'button';
    toggle.onclick = async () => { toggle.disabled = true; try { await api('recipient-toggle', { id: r.id, enabled: !r.enabled }); toast(r.enabled ? 'Destinatário desativado.' : 'Destinatário ativado.'); await refresh(); } catch (error) { toast(error.message, true); } finally { toggle.disabled = false; } };
    actions.append(edit, toggle); card.append(actions); container.append(card);
  }
}
function updateGroupOptions() {
  const select = $('#recipient-form').elements.group_id;
  const selected = editingRecipient?.target_type === 'group' ? editingRecipient.group_id : select.value;
  select.replaceChildren();
  const placeholder = element('option', groupsLoaded ? 'Selecione um grupo' : 'Carregue os grupos da conta conectada'); placeholder.value = ''; select.append(placeholder);
  for (const group of groupCatalog) { const option = element('option', group.name || 'Grupo sem nome'); option.value = group.id; select.append(option); }
  if (selected && !groupCatalog.some(group => group.id === selected)) { const option = element('option', editingRecipient?.name ? editingRecipient.name + ' (indisponível na lista)' : 'Grupo selecionado (indisponível na lista)'); option.value = selected; select.append(option); }
  select.value = selected || '';
}
function updateTargetFields() {
  const form = $('#recipient-form');
  const type = form.elements.target_type.value;
  const group = type === 'group';
  const connected = type === 'connected';
  $('#interaction-fields').hidden = group;
  form.querySelector('[name=events][value="agent.notice"]').disabled=group;
  for (const input of form.querySelectorAll('[name=permissions]')) input.disabled = group;
  $('#phone-field').hidden = group || connected; $('#group-field').hidden = !group; $('#connected-help').hidden = !connected;
  form.elements.phone.disabled = group || connected; form.elements.phone.required = !group && !connected;
  form.elements.group_id.disabled = !group || Boolean(editingRecipient); form.elements.group_id.required = group && !editingRecipient;
  form.elements.target_type.disabled = Boolean(editingRecipient);
  $('#refresh-groups').disabled = groupsLoading || savingRecipient;
}
function validGroupList(groups) {
  return Array.isArray(groups) && groups.every(group => typeof group.id === 'string' && group.id.endsWith('@g.us') && typeof group.name === 'string');
}
function describeGroupCatalog(data) {
  const status = data.catalog?.status || 'ready';
  if (status === 'offline') return 'A conta está offline. Conecte o WhatsApp e atualize a lista.';
  if (status === 'pending') return 'A consulta ainda não terminou. Atualize novamente em alguns segundos.';
  if (status === 'failed') return messages[data.catalog?.error] || messages.group_catalog_failed;
  if (!data.groups.length) return 'Consulta concluída sem grupos. Isso não confirma que a conta não participa de nenhum grupo; confira a participação e atualize de novo.';
  return 'Lista atualizada. São exibidos somente grupos da conta conectada.';
}
async function loadGroups() {
  if (groupsLoading) return;
  const generation = formGeneration;
  const current = () => loggedIn && generation === formGeneration;
  groupsLoading = true; updateTargetFields(); $('#group-status').textContent = 'Solicitando uma nova consulta de grupos ao WhatsApp…';
  try {
    await api('groups-refresh', {});
    const deadline = Date.now() + 45000;
    let data;
    do {
      if (!current()) return;
      data = await api('groups');
      if (data.catalog?.status !== 'pending') break;
      $('#group-status').textContent = 'Consulta solicitada. Aguardando o worker concluir…';
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    if (!current()) return;
    if (!validGroupList(data.groups)) throw new Error('O serviço retornou uma lista de grupos inválida. Atualize novamente.');
    const status = data.catalog?.status || 'ready';
    if (status === 'ready' || data.groups.length) groupCatalog = data.groups;
    groupsLoaded = status === 'ready' || data.groups.length > 0;
    if (groupsLoaded) updateGroupOptions();
    $('#group-status').textContent = describeGroupCatalog(data);
    if (status === 'failed' || status === 'offline') toast($('#group-status').textContent, true);
  } catch (error) { if (current()) { $('#group-status').textContent = error.message; toast(error.message, true); } }
  finally { groupsLoading = false; updateTargetFields(); }
}
function editRecipient(r) {
  const form = $('#recipient-form');
  if (savingRecipient) return;
  editingRecipient = r; formGeneration++;
  form.elements.name.value = r.name; form.elements.phone.value = r.phone || ''; form.elements.audience.value = r.audience;
  form.elements.target_type.value = r.target_type === 'group' ? 'group' : r.follow_session ? 'connected' : 'phone';
  form.elements.phone.readOnly = true; form.elements.audience.readOnly = true;
  updateGroupOptions(); updateTargetFields();
  form.elements.enabled.checked = r.enabled;
  for (const input of form.querySelectorAll('[name=events]')) input.checked = r.events.includes(input.value);
  for (const input of form.querySelectorAll('[name=permissions]')) input.checked = (r.permissions || []).includes(input.value);
  $('#form-title').textContent = 'Editar destinatário'; $('#recipient-mode-label').textContent = 'Destino e perfil mantidos'; $('#cancel-edit').hidden = false; form.elements.name.focus();
}
function resetForm() { const form = $('#recipient-form'); editingRecipient = null; formGeneration++; form.reset(); form.elements.phone.readOnly = false; form.elements.audience.readOnly = false; $('#form-title').textContent = 'Adicionar destinatário'; $('#recipient-mode-label').textContent = 'Número ou grupo'; $('#group-status').textContent = ''; $('#cancel-edit').hidden = true; updateTargetFields(); }
function render(data) {
  events = data.events;
  const s = data.state;
  $('#pairing-reset').disabled = Boolean(data.demo || s.pairing_pending);
  $('#pairing-reset').textContent = s.pairing_pending ? 'Aguardando novo QR…' : 'Gerar novo QR';
  $('#connection-status').textContent = stateLabels[s.status] || s.status;
  $('#connection-status').className = `pill ${s.status === 'connected' ? 'ok' : s.status === 'offline' ? 'off' : 'warn'}`;
  $('#account-phone').textContent = s.account_phone || 'Nenhum número conectado'; $('#account-name').textContent = s.account_name || 'Aguardando pareamento';
  $('#connection-detail').textContent = s.pairing_pending ? 'Reinício solicitado. O worker precisa estar ativo na hospedagem para gerar o QR; se permanecer assim, confira os logs do daemon.' : s.status === 'connected' ? 'Sua conta está pronta para processar as notificações autorizadas.' : s.status === 'offline' ? 'O serviço de conexão não está ativo. Confira o worker e a configuração do banco na hospedagem.' : s.status === 'qr' ? s.qr ? 'Escaneie o código abaixo pelo WhatsApp do celular. O QR é renovado automaticamente até conectar.' : 'Aguardando renovação automática do QR. Permaneça nesta página.' : 'A conexão está sendo preparada. Aguarde nesta página.';
  $('#qr').hidden = !s.qr; $('#qr-help').hidden = !s.qr;
  if (s.qr && $('#qr').src !== s.qr) $('#qr').src = s.qr;
  if (!s.qr) $('#qr').removeAttribute('src');
  $('#backup-status').textContent = s.session_saved_at ? `Backup remoto: ${time(s.session_saved_at)}` : 'Aguardando primeiro backup remoto';
  const recipientSignature = JSON.stringify(data.recipients);
  if (lastSnapshot !== recipientSignature) { renderRecipients(data.recipients); lastSnapshot = recipientSignature; }
  const deliveries = $('#delivery-list'); deliveries.replaceChildren();
  for (const row of data.deliveries) { const tr = element('tr'); for (const [index, value] of [row.name, events[row.event_type] || row.event_type, deliveryLabels[row.status] || row.status, time(row.created_at)].entries()) { const td = element('td', value); if (index === 2 && row.error_code) td.append(element('small', deliveryErrorLabels[row.error_code] || 'O serviço não confirmou o envio. Confira a conexão e o destinatário.', 'delivery-error')); tr.append(td); } deliveries.append(tr); }
  if (!data.deliveries.length) { const tr = element('tr'); const td = element('td', 'Nenhum envio registrado.'); td.colSpan = 4; tr.append(td); deliveries.append(tr); }
  const logs = $('#connection-logs'); logs.replaceChildren();
  for (const row of data.logs) { const item = element('div', undefined, 'log'); const description = element('div', logLabels[row.event] || 'Evento de conexão'); if (row.code) description.append(element('small', row.code)); item.append(description, element('span', time(row.created_at), 'muted')); logs.append(item); }
  if (!data.logs.length) logs.append(element('p', 'Nenhum evento de conexão registrado.', 'empty'));
  $('#refresh-time').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
}
async function refresh() { if (!loggedIn || polling) return; polling = true; try { render(await api('snapshot')); } catch (error) { toast(error.message, true); } finally { polling = false; } }
$('#login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true; try { await api('login', { token: form.elements.token.value }); form.reset(); showDashboard(false); await refresh(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('logout', {}); showLogin(); } catch (error) { toast(error.message, true); } };
$('#pairing-reset').onclick = async () => {
  if (!window.confirm('Gerar um novo QR encerra a sessão atual neste serviço. Será necessário escanear com o número remetente. Destinatários e histórico serão mantidos. Continuar?')) return;
  const button = $('#pairing-reset'); button.disabled = true;
  try {
    await api('pairing-reset', { confirm: 'reset_pairing' });
    $('#qr').hidden = true; $('#qr').removeAttribute('src');
    toast('Novo pareamento solicitado. Aguarde o worker reiniciar e o QR aparecer nesta página.');
    await refresh();
  } catch (error) { toast(error.message, true); button.disabled = false; }
};
$('#cancel-edit').onclick = resetForm;
$('#refresh-groups').onclick = loadGroups;
$('#recipient-form').elements.target_type.onchange = () => { updateTargetFields(); if ($('#recipient-form').elements.target_type.value === 'group' && !groupsLoaded) loadGroups(); };
$('#recipient-form').elements.group_id.onchange = () => { const form = $('#recipient-form'); const group = groupCatalog.find(item => item.id === form.elements.group_id.value); if (group && !form.elements.name.value.trim()) form.elements.name.value = group.name; };
$('#recipient-form').onsubmit = async event => { event.preventDefault(); if (savingRecipient) return; const form = event.currentTarget; const button = form.querySelector('button[type=submit], button.primary'); const data = new FormData(form);
  const selectedType = editingRecipient?.target_type === 'group' ? 'group' : editingRecipient?.follow_session ? 'connected' : editingRecipient ? 'phone' : form.elements.target_type.value;
  const targetType = selectedType === 'connected' ? 'phone' : selectedType;
  const payload = { name: data.get('name'), target_type: targetType, follow_session: selectedType === 'connected', audience: editingRecipient?.audience || data.get('audience'), events: data.getAll('events'), permissions: targetType === 'phone' ? data.getAll('permissions') : [], enabled: form.elements.enabled.checked };
  if (targetType === 'group') payload.group_id = editingRecipient?.group_id || form.elements.group_id.value;
  else if (selectedType !== 'connected') payload.phone = editingRecipient?.phone || data.get('phone');
  savingRecipient = true; button.disabled = true; $('#cancel-edit').disabled = true; updateTargetFields();
  try { await api('recipients', payload); resetForm(); toast('Destinatário salvo.'); await refresh(); } catch (error) { toast(error.message, true); } finally { savingRecipient = false; button.disabled = false; $('#cancel-edit').disabled = false; updateTargetFields(); }
};
const paneCopy = {
  connect: ['Conectividade', 'Conta do WhatsApp, status e pareamento.'],
  logs: ['Logs', 'Últimos envios e eventos desta seção.'],
  alerts: ['Adicionar alertas', 'Cadastre destinatários e escolha os alertas e as permissões de cada pessoa.']
};
function showTab(name) {
  const [title, copy] = paneCopy[name] || paneCopy.connect;
  $('#pane-title').textContent = title;
  $('#pane-copy').textContent = copy;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const on = button.dataset.tab === name;
    button.classList.toggle('active', on);
    if (on) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== name;
}
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => showTab(button.dataset.tab);
api('session').then(data => { events = data.events; if (data.authenticated) { showDashboard(data.demo); refresh(); } else showLogin(); }).catch(error => toast(error.message, true));
setInterval(refresh, 5000);
