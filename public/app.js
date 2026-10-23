const $ = selector => document.querySelector(selector);
const messages = {
  invalid_credentials: 'Chave de administração incorreta.', authentication_required: 'Entre novamente no painel.',
  configuration_required: 'Configure as variáveis de ambiente e o banco antes de entrar.', service_unavailable: 'Serviço indisponível. Confira a conexão com o banco e as migrations.',
  login_rate_limited: 'Muitas tentativas. Aguarde dez minutos.', invalid_input: 'Confira os campos e selecione ao menos um alerta.',
  phone_requires_country_code: 'Informe o número com +, DDI e DDD. Exemplo: +55 11 99999-9999.', origin_rejected: 'O endereço do painel difere do APP_ORIGIN configurado.'
};
const stateLabels = { offline: 'Serviço offline', connecting: 'Conectando', qr: 'Escaneie o QR', authenticated: 'Finalizando conexão', connected: 'Conectado' };
const deliveryLabels = { pending: 'Na fila', sending: 'Enviando', sent: 'Enviado', failed: 'Falhou', uncertain: 'Sem confirmação', cancelled: 'Cancelado' };
const logLabels = { worker_started: 'Serviço iniciado', worker_stopped: 'Serviço encerrado', qr_issued: 'QR Code renovado', authenticated: 'Pareamento aceito', connected: 'WhatsApp conectado', session_saved: 'Backup da sessão salvo', auth_failure: 'Falha na autenticação', disconnected: 'WhatsApp desconectado' };
let currentRecipients = [];
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
function showLogin() { loggedIn = false; $('#login').hidden = false; $('#dashboard').hidden = true; $('#logout').hidden = true; $('#qr').removeAttribute('src'); }
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
    card.append(head, element('div', r.phone, 'recipient-phone'), element('div', `Perfil: ${r.audience}`, 'recipient-profile'));
    const tags = element('div', undefined, 'tags'); for (const type of r.events) tags.append(element('span', events[type] || type, 'tag')); card.append(tags);
    const actions = element('div', undefined, 'recipient-actions');
    const edit = element('button', 'Editar', 'quiet'); edit.type = 'button'; edit.onclick = () => editRecipient(r);
    const toggle = element('button', r.enabled ? 'Desativar' : 'Ativar', 'quiet'); toggle.type = 'button';
    toggle.onclick = async () => { toggle.disabled = true; try { await api('recipient-toggle', { id: r.id, enabled: !r.enabled }); toast(r.enabled ? 'Destinatário desativado.' : 'Destinatário ativado.'); await refresh(); } catch (error) { toast(error.message, true); } finally { toggle.disabled = false; } };
    actions.append(edit, toggle); card.append(actions); container.append(card);
  }
}
function editRecipient(r) {
  const form = $('#recipient-form');
  form.elements.name.value = r.name; form.elements.phone.value = r.phone; form.elements.audience.value = r.audience;
  form.elements.phone.readOnly = true; form.elements.audience.readOnly = true;
  form.elements.enabled.checked = r.enabled;
  for (const input of form.querySelectorAll('[name=events]')) input.checked = r.events.includes(input.value);
  $('#form-title').textContent = 'Editar destinatário'; $('#cancel-edit').hidden = false; form.elements.name.focus();
}
function resetForm() { const form = $('#recipient-form'); form.reset(); form.elements.phone.readOnly = false; form.elements.audience.readOnly = false; $('#form-title').textContent = 'Adicionar destinatário'; $('#cancel-edit').hidden = true; }
function render(data) {
  events = data.events;
  const s = data.state;
  $('#connection-status').textContent = stateLabels[s.status] || s.status;
  $('#connection-status').className = `pill ${s.status === 'connected' ? 'ok' : s.status === 'offline' ? 'off' : 'warn'}`;
  $('#account-phone').textContent = s.account_phone || 'Nenhum número conectado'; $('#account-name').textContent = s.account_name || 'Aguardando pareamento';
  $('#connection-detail').textContent = s.status === 'connected' ? 'Sua conta está pronta para processar as notificações autorizadas.' : s.status === 'offline' ? 'O serviço de conexão não está ativo. Confira o worker e a configuração do banco na hospedagem.' : s.status === 'qr' ? 'Escaneie o código abaixo pelo WhatsApp do celular.' : 'A conexão está sendo preparada. Aguarde nesta página.';
  $('#qr').hidden = !s.qr; $('#qr-help').hidden = !s.qr;
  if (s.qr && $('#qr').src !== s.qr) $('#qr').src = s.qr;
  if (!s.qr) $('#qr').removeAttribute('src');
  $('#backup-status').textContent = s.session_saved_at ? `Backup remoto: ${time(s.session_saved_at)}` : 'Aguardando primeiro backup remoto';
  const recipientSignature = JSON.stringify(data.recipients);
  if (lastSnapshot !== recipientSignature) { renderRecipients(data.recipients); lastSnapshot = recipientSignature; }
  const deliveries = $('#delivery-list'); deliveries.replaceChildren();
  for (const row of data.deliveries) { const tr = element('tr'); for (const value of [row.name, events[row.event_type] || row.event_type, deliveryLabels[row.status] || row.status, time(row.created_at)]) tr.append(element('td', value)); deliveries.append(tr); }
  if (!data.deliveries.length) { const tr = element('tr'); const td = element('td', 'Nenhum envio registrado.'); td.colSpan = 4; tr.append(td); deliveries.append(tr); }
  const logs = $('#connection-logs'); logs.replaceChildren();
  for (const row of data.logs) { const item = element('div', undefined, 'log'); const description = element('div', logLabels[row.event] || 'Evento de conexão'); if (row.code) description.append(element('small', row.code)); item.append(description, element('span', time(row.created_at), 'muted')); logs.append(item); }
  if (!data.logs.length) logs.append(element('p', 'Nenhum evento de conexão registrado.', 'empty'));
  $('#refresh-time').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
}
async function refresh() { if (!loggedIn || polling) return; polling = true; try { render(await api('snapshot')); } catch (error) { toast(error.message, true); } finally { polling = false; } }
$('#login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true; try { await api('login', { token: form.elements.token.value }); form.reset(); showDashboard(false); await refresh(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('logout', {}); showLogin(); } catch (error) { toast(error.message, true); } };
$('#cancel-edit').onclick = resetForm;
$('#recipient-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const data = new FormData(form); button.disabled = true;
  try { await api('recipients', { name: data.get('name'), phone: data.get('phone'), audience: data.get('audience'), events: data.getAll('events'), enabled: form.elements.enabled.checked }); resetForm(); toast('Destinatário salvo.'); await refresh(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
};
api('session').then(data => { events = data.events; if (data.authenticated) { showDashboard(data.demo); refresh(); } else showLogin(); }).catch(error => toast(error.message, true));
setInterval(refresh, 5000);
