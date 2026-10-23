# WhatsApp Mensageria

Projeto separado para receber notificacoes do Super App/Jarvis e envia-las pelo WhatsApp.
Painel administrativo em HTTPS, uma Function de controle e um Daemon Node.js com Chromium.

## O que esta implementado

- Login por chave administrativa; cookie HttpOnly, SameSite=Strict e Secure em HTTPS.
- Numero e nome da conta conectada, QR temporario, estado e backup da sessao.
- Cadastro/edicao de destinatarios, ativacao e selecao de agua, dieta e resumo financeiro.
- Separacao por perfil (`audience`) e autenticacao distinta para integracoes.
- Fila PostgreSQL com idempotencia, lease de worker unico e historico dos envios.
- Logs de conexao sem mensagens, QR ou credenciais em texto aberto.
- Backup RemoteAuth criptografado AES-256-GCM no banco.
- Migration manual Supabase, rollback e testes com PostgreSQL embarcado (PGlite).

O projeto esta preparado para validacao de deploy; a conexao no container Vercel nao foi comprovada.
Nenhuma migration ou alteracao de configuracao foi aplicada ao Supabase/Vercel automaticamente.
O Super App nao foi alterado: seu adaptador de exemplo esta em `examples/superapp-client.mjs`.

## Arquitetura

```text
cron-job.org -> Super App -> POST /api/control?action=event
                               | token de integracao
                               v
                     PostgreSQL/Supabase: fila
                               |
                     Daemon WhatsApp (1 instancia)
                               |
                     WhatsApp dos destinatarios

Painel HTTPS -> API autenticada -> configuracoes, estado e logs no mesmo banco
```

O Daemon nao recebe HTTP de entrada; busca a fila no banco.
HTTPS usa o dominio do projeto na porta padrao 443; nao e necessario abrir a porta 3337 na Vercel.

## 1. Criar tabelas manualmente no Supabase

1. Abra o SQL Editor do projeto Supabase escolhido.
2. Revise e execute `migrations/001_mensageria.sql`.
3. O script cria somente o schema `mensageria`, com sete tabelas, indices e RLS habilitada.
4. Nao exponha esse schema no PostgREST/Data API. O backend usa conexao PostgreSQL direta.
5. Use DATABASE_URL com o papel proprietario dessas tabelas (por exemplo, o mesmo usuario
   que executou a migration). Caso escolha outro papel, configure os grants/policies
   adequados manualmente; RLS sem policies nao permite acesso de um papel comum.

Tabelas:

| Tabela | Finalidade |
| --- | --- |
| recipients | Numeros, perfil, tipos de alerta e estado ativo |
| ingress | Chaves de idempotencia e hash do pedido |
| deliveries | Fila e resultado individual por destinatario |
| connection_state | Numero conectado, lease, heartbeat e QR criptografado temporario |
| session_backups | Arquivo RemoteAuth criptografado |
| connection_logs | Conexoes, desconexoes, QR renovado e backup salvo |
| login_limits | Limite persistente de tentativas de login |

`001_rollback.sql` e DESTRUTIVO. So executar com backup, aplicacao parada e autorizacao.
Ele remove apenas os objetos da migration; nao usa DROP SCHEMA CASCADE.

## 2. Variaveis de ambiente

Execute `npm run secrets` no seu computador. Isso cria `.env.local`, sem sobrescrever
arquivo existente e sem imprimir os segredos no terminal. Complete a conexao PostgreSQL.

No projeto Vercel, cadastre as variaveis abaixo em Production. Nao use prefixos publicos.

| Variavel | Conteudo |
| --- | --- |
| APP_ORIGIN | URL HTTPS canonica exata, sem barra final: https://seu-projeto.vercel.app |
| DATABASE_URL | Conexao PostgreSQL Supabase, preferencialmente pooler transacional porta 6543 |
| DATABASE_CA_CERT | Opcional: certificado CA do banco, se exigido pela cadeia TLS |
| ADMIN_TOKEN | Chave aleatoria de administracao com pelo menos 32 caracteres |
| INTEGRATION_TOKEN | Outra chave aleatoria, exclusiva do backend Super App/Jarvis |
| SESSION_ENCRYPTION_KEY | Chave de 32 bytes em hexadecimal (64 caracteres) |

Use valores diferentes para ADMIN_TOKEN e INTEGRATION_TOKEN.
No local, APP_ORIGIN deve ser http://127.0.0.1:3338.
O driver verifica certificados TLS. Nao configurar rejectUnauthorized=false.
Para senhas com caracteres especiais, use a string de conexao corretamente codificada
fornecida pelo Supabase, sem imprimir sua URL em logs.

Guarde SESSION_ENCRYPTION_KEY em local seguro. Perde-la impede recuperar o backup
e exige novo pareamento. Nao trocar a chave sem um plano de migracao das sessoes.
O backup inicial RemoteAuth acontece cerca de um minuto depois do pareamento;
espere o painel confirmar o backup antes de reiniciar o worker. Backups seguintes: 5 minutos.
O snapshot criptografado tem limite de 128 MiB. Monitore o espaco do banco.

## 3. Importar o repositorio na Vercel

1. Versione codigo/configuracao; nunca envie `.env.local`, `.runtime`, `.wwebjs_auth`
   ou a sessao que ficou na pasta original de testes.
2. Importe `Acmsilva1/wastapp-mensageria` como projeto independente.
3. Root Directory: raiz do repositorio, sem subpasta. Node.js: 24.x. Framework: Other.
4. `vercel.json` define build `npm run build`, saida estatica `public`, uma Function
   `api/control.mjs` e um Daemon `whatsapp` usando `Dockerfile.whatsapp`, com uma instancia.
5. Configure as variaveis e confirme o APP_ORIGIN com o dominio atribuido ao projeto.
   Alteracoes de variaveis exigem novo deploy.
6. Publique em Production: Daemons nao rodam nos previews durante a beta.
7. Confira os logs da Function/Daemon, abra a URL e entre com ADMIN_TOKEN.
8. Escaneie o QR e aguarde numero conectado + backup remoto confirmado.

O container instala Chromium do Debian, executa como usuario nao root e mantem
o sandbox do navegador habilitado. Sua compatibilidade com o runtime Vercel precisa
ser validada no primeiro deploy. Nao ha enfraquecimento automatico do sandbox.

Se a Vercel rejeitar a configuracao beta ou o Chromium nao iniciar, nao considere
o deploy validado; revise os logs sanitizados e os requisitos atuais do provedor.
Um build estatico concluido nao prova que o WhatsApp ficou conectado.

## 4. Cadastrar destinatarios e integrar o app

O campo Perfil do Super App deve receber o mesmo identificador enviado em `audience`.
Para agua/dieta, use o UUID do perfil de saude correspondente. Para financeiro,
use o identificador do proprietario correspondente ao resumo; o adaptador do app
deve fazer esse mapeamento explicitamente. Nao habilite perfis gerais implicitamente.

O mesmo telefone pode estar associado a mais de um perfil. Para editar nome,
tipos de alerta ou ativacao, use Editar. Para um telefone/perfil diferente, adicione
outro cadastro e desative o antigo se necessario.

API de integracao, somente pelo BACKEND:

```http
POST https://seu-projeto.vercel.app/api/control?action=event
Authorization: Bearer <INTEGRATION_TOKEN>
Content-Type: application/json

{
  "source": "superapp",
  "event_type": "health.water_progress",
  "audience": "UUID-DO-PERFIL",
  "idempotency_key": "agua:2026-10-23:10:UUID-DO-PERFIL",
  "title": "Lembrete de agua",
  "message": "Seu lembrete do Super App."
}
```

Tipos aceitos: `health.water_progress`, `health.diet_menu`, `financeiro.daily_summary`.
`source` aceita `superapp` ou `jarvis`. Use chave unica por ocorrencia e reenvie
a MESMA chave/conteudo ao repetir uma requisicao que sofreu timeout.
HTTP 202 significa enfileirado, nao entregue. HTTP 422 significa que nenhum
destinatario ativo foi autorizado para aquele perfil/tipo. HTTP 409 indica
reuso da chave com conteudo diferente.

O envio revalida as permissoes do destinatario antes de chamar WhatsApp.
Desativar destinatario cancela seus envios pendentes, mas nao desfaz envio em andamento.
Nao existem endpoints publicos de envio arbitrario para qualquer numero.
O cron atual continua no Super App; nao cadastre outro cron para duplicar os alertas.

## Operacao e privacidade

- Logs de conexao e historico de envios: retencao automatica de 30 dias.
- Conteudo da notificacao: somente enquanto pendente; removido apos processamento.
- Pendencias com mais de 24 horas sao canceladas para evitar alertas atrasados.
- `sent` significa aceito pela biblioteca; nao confirma entrega/leitura no celular.
- Falha depois de iniciar o envio fica `uncertain`; nao ha reenvio automatico, pois
  a mensagem pode ter sido enviada. O operador deve conferir antes de novo disparo.
- A sessao do navegador pode conter dados de autenticacao do WhatsApp: e criptografada
  antes de sair do worker. ADMIN_TOKEN da acesso ao painel/QR; mantenha-o privado.
- Configure apenas uma instancia/regiao. O lease de banco tambem evita dois workers
  ativos em deploys sobrepostos; uma instancia substituta aguarda ate 90 segundos.
- A conta pode ser desvinculada pelo WhatsApp em Aparelhos conectados.
- Daemons estao em beta; cotas sao compartilhadas por equipe, inclusive entre projetos.

## Rodar e testar localmente

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run demo
```

Demo em http://127.0.0.1:3338, sem banco, conta real ou envio. Dados somem ao reiniciar.

Com banco e variaveis configurados em .env.local:

```powershell
npm.cmd start
# Outro terminal; mantenha a variavel PUPPETEER_CACHE_DIR quando usando o browser local:
$env:PUPPETEER_CACHE_DIR = Join-Path (Get-Location) '.browsers'
npm.cmd run worker:local
```

Validar container (Docker Desktop Linux precisa estar iniciado):

```powershell
docker build -f Dockerfile.whatsapp -t whatsapp-mensageria-worker .
docker run --rm --env-file .env.local whatsapp-mensageria-worker
```

Os exemplos antigos `npm run painel:legado`, `npm run webjs` e `npm run baileys`
continuam disponiveis para testes locais. Nao compartilham o backup RemoteAuth
deste novo worker. Nao executar instancias concorrentes da mesma sessao.

## Referencias

- https://vercel.com/docs/daemons
- https://vercel.com/docs/daemons/limits
- https://wwebjs.dev/guide/creating-your-bot/authentication.html

whatsapp-web.js e Baileys sao bibliotecas nao oficiais do WhatsApp.
