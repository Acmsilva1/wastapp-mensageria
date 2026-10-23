const path = require('node:path');
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.browsers');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true }
});
client.on('qr', qr => {
  console.log('WhatsApp > Aparelhos conectados > Conectar aparelho. Escaneie o QR:');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => console.log('whatsapp-web.js conectado. Nenhuma mensagem automatica sera enviada. Ctrl+C para sair.'));
client.on('auth_failure', () => console.error('Falha na autenticacao. Verifique os aparelhos conectados no WhatsApp.'));
client.on('disconnected', () => console.log('WhatsApp desconectado. Execute npm run webjs para reconectar.'));
process.on('SIGINT', async () => {
  try { await client.destroy(); } finally { process.exit(0); }
});
client.initialize().catch(() => {
  console.error('Nao foi possivel iniciar o whatsapp-web.js. Verifique a rede e o navegador Puppeteer.');
  process.exitCode = 1;
});
