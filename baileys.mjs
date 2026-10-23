import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { fileURLToPath } from 'node:url';

const logger = pino({ level: 'silent' });
const authPath = fileURLToPath(new URL('./.auth-baileys/', import.meta.url));
let stopping = false;
let activeSocket;
let retryTimer;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const socket = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });
  activeSocket = socket;
  socket.ev.on('creds.update', () => {
    saveCreds().catch(() => console.error('Falha ao salvar a sessao local.'));
  });
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('WhatsApp > Aparelhos conectados > Conectar aparelho. Escaneie o QR:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('Baileys conectado. Nenhuma mensagem automatica sera enviada. Ctrl+C para sair.');
    if (connection === 'close' && !stopping) {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Sessao encerrada pelo WhatsApp. Remova apenas .auth-baileys para parear novamente.');
      } else {
        console.log('Conexao interrompida. Nova tentativa em 5 segundos.');
        retryTimer = setTimeout(() => connect().catch(handleError), 5000);
      }
    }
  });
}
function handleError() {
  console.error('Nao foi possivel iniciar o Baileys. Verifique a rede e as dependencias.');
  process.exitCode = 1;
}
process.on('SIGINT', () => {
  stopping = true;
  clearTimeout(retryTimer);
  activeSocket?.end(new Error('Encerrado pelo usuario'));
  process.exit(0);
});
connect().catch(handleError);
