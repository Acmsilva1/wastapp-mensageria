# Mensageria no celular

O painel oferece um PWA visual com ícone próprio, janela independente, instalação e aviso de nova versão. A conexão do WhatsApp continua no worker existente; instalar o painel não transfere o worker para o celular.

## Instalar

Depois da publicação, abra `https://mensageria-andre-zap.duckdns.org` no celular:

- Android: toque em **Instalar app**, quando o navegador oferecer, ou use **Instalar aplicativo / Adicionar à tela inicial** no menu.
- iPhone/iPad: no menu Compartilhar, escolha **Adicionar à Tela de Início** e habilite abrir como aplicativo quando disponível.

O painel exige internet e o mesmo acesso administrativo usado no navegador. A instalação depende do navegador e de HTTPS válido; localhost é permitido apenas para desenvolvimento.

## Atualizações e offline

- O aviso **Atualizar app** ativa uma nova versão do service worker e recarrega a interface.
- Offline, aparece uma página pública explicando a necessidade de reconectar.
- Apenas essa página offline, seu CSS e os ícones entram no cache do PWA.
- APIs, sessões, QR Codes, HTML do painel autenticado e respostas de controle não são armazenados nesse cache. O PWA não fornece métricas ou estado do WhatsApp offline.
- Não há permissão de push, câmera, microfone ou envio adicional de mensagens por causa do PWA.

## Desenvolvimento e validação

No PowerShell, em uma sessão própria:

```powershell
$env:PORT = '3348'
node scripts/serve.mjs --demo
```

Abra `http://127.0.0.1:3348`. A demonstração usa dados fictícios e bloqueia envios e pareamento reais.

```powershell
npm run check
npm test
```

Os quatro testes em `tests/pwa.test.mjs` verificam manifest, dimensões PNG, isolamento do cache, fallback offline e rotas HTTP. No Windows, a criação de um subprocesso pode exigir execução fora do sandbox; uma falha `spawn EPERM` não comprova falha funcional do PWA.

## Publicação na VPS

Publicado em 28/10/2026, após autorização: somente o container `mensageria-painel` foi reconstruído e recriado. O worker permaneceu no mesmo container e imagem, com o mesmo horário de início, zero reinícios e a mesma conta conectada. Os arquivos remotos `app.js` e `styles.css` foram preservados; o HTML remoto recebeu apenas as inclusões do PWA.

O servidor local `scripts/serve.mjs` já entrega os novos arquivos. O `Dockerfile.panel` e a adaptação de servidor usados atualmente na VPS não estão versionados neste checkout. Em futuras publicações, é necessário preservar esse empacotamento, volume e pareamento, e assegurar que o domínio continue servindo `/manifest.webmanifest`, `/sw.js`, `/pwa.js`, `/pwa.css`, `/offline.html`, `/pwa-offline.css` e `/icons/*`.

`/sw.js` deve retornar JavaScript e ter escopo `/`; o servidor local já envia `Service-Worker-Allowed: /`. Não apontar essas rotas para uma página HTML genérica. O smoke HTTPS confirmou 200, MIME correto e ícones PNG nas dimensões declaradas para todas as rotas do PWA. A instalação em aparelho físico e a atualização do app instalado ainda precisam ser verificadas.

## Atualização de 29/10/2026

O Dockerfile.panel e o servidor da VPS agora integram o checkout. O build e npm run check geram automaticamente a versão do cache pelo conteúdo dos assets. O visual e CRUD foram publicados em HTTPS, preservando worker e pareamento. Veja [UI-PWA](UI-PWA.md) para o procedimento obrigatório de atualização e os limites dos testes.
