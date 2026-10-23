import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const host = '127.0.0.1';
const port = 3337;
const origin = `http://${host}:${port}`;
const html = await readFile(new URL('./painel.html', import.meta.url));
const logger = pino({ level: 'silent' });
process.env.PUPPETEER_CACHE_DIR = fileURLToPath(new URL('./.browsers/', import.meta.url));
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require('whatsapp-web.js');
const authPath = fileURLToPath(new URL('./.auth-baileys/', import.meta.url));
const status = { state: 'starting', detail: 'Iniciando conexão…', qr: null, account: null };
let socket;
let generation = 0;
let retries = 0;
let retryTimer;
let stopping = false;
let webClient;

async function connectWeb() {
  status.state = 'connecting';
  status.detail = 'Abrindo o WhatsApp Web no navegador local…';
  webClient = new Client({
    authStrategy: new LocalAuth({ dataPath: fileURLToPath(new URL('./.wwebjs_auth/', import.meta.url)) }),
    puppeteer: { headless: true }
  });
  webClient.on('qr', async qr => {
    const current = ++generation;
    try {
      const data = await QRCode.toDataURL(qr, { scale: 8, margin: 4, errorCorrectionLevel: 'M' });
      if (stopping || current !== generation) return;
      status.state = 'qr';
      status.detail = 'Novo QR do WhatsApp Web. Abra Aparelhos conectados no celular para escanear.';
      status.qr = data;
    } catch { failed(); }
  });
  webClient.on('authenticated', () => {
    generation++;
    status.qr = null;
    status.state = 'connecting';
    status.detail = 'QR aceito! Finalizando a conexão…';
  });
  webClient.on('ready', () => {
    generation++;
    status.state = 'connected';
    status.qr = null;
    status.account = webClient.info?.pushname || 'WhatsApp conectado';
    status.detail = 'Conta conectada pelo whatsapp-web.js. Nenhuma mensagem será enviada automaticamente.';
    console.log('WhatsApp Web conectado.');
  });
  webClient.on('auth_failure', () => { generation++; failed(); });
  webClient.on('disconnected', () => {
    generation++;
    status.state = 'logged_out';
    status.qr = null;
    status.account = null;
    status.detail = 'WhatsApp Web desconectado. Reinicie o serviço para tentar novamente.';
    console.log('WhatsApp Web desconectado.');
  });
  await webClient.initialize();
}

async function connect() {
  const current = ++generation;
  status.state = 'connecting';
  status.detail = 'Aguardando o WhatsApp…';
  status.qr = null;
  status.account = null;
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  if (stopping) return;
  socket = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });
  const currentSocket = socket;
  currentSocket.ev.on('creds.update', () => {
    saveCreds().catch(() => { status.detail = 'Falha ao salvar a sessão no computador.'; });
  });
  currentSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (current !== generation || stopping) return;
    if (qr) {
      try {
        const data = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        if (current !== generation || stopping || status.state === 'connected') return;
        status.state = 'qr';
        status.detail = 'Escaneie o QR Code pelo WhatsApp do celular.';
        status.qr = data;
      } catch { status.detail = 'Não foi possível desenhar o QR Code.'; }
    }
    if (connection === 'open') {
      retries = 0;
      status.state = 'connected';
      status.detail = 'Conta conectada. Nenhuma mensagem será enviada automaticamente.';
      status.qr = null;
      status.account = currentSocket.user?.name || 'WhatsApp conectado';
      console.log('WhatsApp conectado; dados da conta permanecem no painel local.');
    }
    if (connection === 'close') {
      generation++;
      status.qr = null;
      status.account = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        status.state = 'logged_out';
        status.detail = 'O WhatsApp encerrou esta sessão. Será necessário preparar um novo pareamento.';
      } else if (++retries <= 5) {
        status.state = 'connecting';
        status.detail = `Reconectando ao WhatsApp (${retries}/5)…`;
        retryTimer = setTimeout(() => connect().catch(failed), 4000);
      } else {
        status.state = 'error';
        status.detail = 'Não foi possível conectar após 5 tentativas. Reinicie o serviço para tentar novamente.';
      }
      console.log(`Conexão encerrada (código ${code ?? 'indisponível'}).`);
    }
  });
}
function failed() {
  status.state = 'error';
  status.qr = null;
  status.detail = 'Falha ao iniciar a conexão. Verifique o acesso à internet e reinicie o serviço.';
  console.error('Falha na conexão com WhatsApp.');
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (req.headers.host !== `${host}:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403); res.end('Acesso local somente.'); return;
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  if (req.method === 'GET' && req.url === '/api/status' && req.headers['x-local-panel'] === '1') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(status)); return;
  }
  res.writeHead(404); res.end('Não encontrado.');
});
server.on('error', err => { console.error(`Servidor local: ${err.code}`); process.exit(1); });
server.listen(port, host, () => { console.log(`Painel local: ${origin} (whatsapp-web.js)`); connectWeb().catch(failed); });
function shutdown() {
  stopping = true;
  clearTimeout(retryTimer);
  socket?.end(new Error('Serviço local encerrado'));
  webClient?.destroy().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
