# Padrão visual e atualização PWA

Mensageria e Central usam os tokens do Super App (styles/bank-theme.css): fundo cinza, superfícies claras, destaque vermelho, tipografia nativa e cores semânticas. public/ui.css e public/ui.js padronizam tema claro/escuro, confirmações e feedback. public/visual.css adapta cada aplicação.

A Mensageria tem busca/filtro de contatos, criação/edição em modal e exclusão lógica. Excluir desativa o contato e cancela envios pendentes, preservando histórico. Recriar o mesmo destino/perfil restaura o cadastro. Destino e perfil são mantidos durante edição. Em PostgreSQL, aplicar migrations/008_recipient_archive.sql antes de usar exclusão; o ambiente VPS atual usa volume JSON.

## Publicação obrigatória do PWA

- Executar npm run check e os testes antes da publicação.
- scripts/sync-pwa-version.mjs calcula a versão a partir de todos os arquivos públicos; npm run check e o Docker build executam esse passo automaticamente.
- Incluir public/sw.js gerado no commit, junto com os arquivos alterados.
- Publicar assets e service worker na mesma versão. Conferir Cache-Control: no-store em /sw.js e testar o aviso Atualizar app.
- Ao retornar ao app, a busca por atualização é repetida. O usuário confirma antes de recarregar, para salvar formulários em andamento.
- O cache offline contém somente a página pública offline e seus assets. APIs, sessões, contatos e histórico autenticado não são armazenados pelo service worker.
- Após publicar, conferir HTTPS, login e leitura de dados. Instalação e atualização em aparelho físico exigem validação no celular.

A Central mantém somente seus modais existentes; este ajuste não cria cadastro de regras de alerta. A publicação dos painéis não exige recriar o worker WhatsApp.
