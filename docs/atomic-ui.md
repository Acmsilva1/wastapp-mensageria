# Atomic UI — piloto 1.0.0

Esta etapa extrai somente confirmações e mensagens. Regras de negócio, APIs,
temas e funcionalidades continuam nos respectivos apps. Não é uma migração
completa das telas para Atomic Design.

- Átomos (`atoms/dom.mjs`): criação segura de elementos e botões.
- Moléculas (`molecules/message.mjs`): mensagens acessíveis, sem HTML de entrada.
- Organismos (`organisms/feedback.mjs`): confirmação modal, toast e aviso de sucesso.
- Adaptadores: `public/ui.js` nos painéis e `lib/uiConfirmation.js` no Super App.

A fonte canônica está em `components/ui` no repositório do Super App. Os painéis
incluem cópias idênticas em `public/ui`, sem dependência entre servidores ou CDN.
Cada repositório publica sua cópia somente após validação. Ao alterar a base,
atualize sua versão e sincronize explicitamente pelo Super App:

```powershell
node scripts/sync-atomic-ui.mjs "CAMINHO_DO_REPOSITORIO_MENSAGERIA" "CAMINHO_DO_REPOSITORIO_CENTRAL"
node scripts/sync-atomic-ui.mjs --check "CAMINHO_DO_REPOSITORIO_MENSAGERIA" "CAMINHO_DO_REPOSITORIO_CENTRAL"
```

Preservados: `AppUI.confirm`, `AppUI.toast`, `AppUI.closeConfirmation`, tema claro
da Mensageria, alternância de tema da Central e aviso do Super App por um segundo
sem roubar foco. Os estilos existentes continuam sendo usados.

Os servidores dos painéis permitem apenas as três novas rotas estáticas explícitas;
os módulos usam MIME JavaScript. A versão PWA é recalculada por `npm run check`.

Validação local: usar `npm run demo` nos painéis e `npm run preview:local` no
Super App. Todos esses modos simulam dados; não executar worker, envio de teste
ou modo real para validar componentes visuais.
