/**
 * patch-whatsapp-web.mjs
 *
 * Corrige race condition em whatsapp-web.js@1.34.7 onde WAWebSocketModel.Socket
 * pode ser null no momento do inject(), causando crash "Cannot read properties of null".
 *
 * Este script deve ser executado como parte do build (após npm ci).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const clientPath = path.resolve(
  fileURLToPath(import.meta.url),
  '../../node_modules/whatsapp-web.js/src/Client.js',
);

let src = readFileSync(clientPath, 'utf8');

// --- Patch 1: aguardar WAWebSocketModel.Socket não ser null antes de acessar .state ---
const NEEDLE = `const needAuthentication = await this.pupPage.evaluate(async () => {
            let state = window.require('WAWebSocketModel').Socket.state;`;

const REPLACEMENT = `const needAuthentication = await this.pupPage.evaluate(async () => {
            // PATCH: aguarda WAWebSocketModel.Socket estar disponivel (race condition fix)
            const _wsDeadline = Date.now() + 30000;
            while (Date.now() < _wsDeadline) {
                try {
                    const _wsSocket = window.require && window.require('WAWebSocketModel') && window.require('WAWebSocketModel').Socket;
                    if (_wsSocket) break;
                } catch (_) {}
                await new Promise(r => setTimeout(r, 300));
            }
            let state = window.require('WAWebSocketModel').Socket.state;`;

if (!src.includes(NEEDLE)) {
  // Tenta versao sem indentacao exata (fallback com regex)
  const re = /(const needAuthentication = await this\.pupPage\.evaluate\(async \(\) => \{\s*\n\s*)(let state = window\.require\('WAWebSocketModel'\)\.Socket\.state;)/;
  if (!re.test(src)) {
    console.error('PATCH FAILED: target string not found in Client.js — versao da biblioteca pode ter mudado.');
    process.exit(1);
  }
  src = src.replace(re, (_, prefix, stateLine) =>
    prefix +
    '// PATCH: aguarda WAWebSocketModel.Socket estar disponivel (race condition fix)\n' +
    '            const _wsDeadline = Date.now() + 30000;\n' +
    '            while (Date.now() < _wsDeadline) {\n' +
    '                try {\n' +
    "                    const _wsSocket = window.require && window.require('WAWebSocketModel') && window.require('WAWebSocketModel').Socket;\n" +
    '                    if (_wsSocket) break;\n' +
    '                } catch (_) {}\n' +
    '                await new Promise(r => setTimeout(r, 300));\n' +
    '            }\n' +
    '            ' + stateLine,
  );
  console.log('Applied patch via regex fallback.');
} else {
  src = src.replace(NEEDLE, REPLACEMENT);
  console.log('Applied patch via exact string match.');
}

writeFileSync(clientPath, src, 'utf8');
console.log(`Patched: ${clientPath}`);
console.log('whatsapp-web.js Client.js patch applied successfully.');
