# Compras por texto e áudio

O worker da mensageria interpreta compras com Groq. A chave `GROQ_API_KEY` fica somente no ambiente do worker da VPS. O Super App recebe dados estruturados e confirmados, valida e registra no Financeiro com idempotência. A Groq não recebe chaves de banco ou do Super App.

## Uso

Na conversa consigo mesmo da conta conectada, envie texto ou áudio como:

- “Gastei trinta e cinco reais e cinquenta centavos na padaria, no débito.”
- “Almoço quinze reais e café cinco reais, tudo no Pix.”

O bot mostra descrição, valores, pagamento, total, data de hoje e categoria Outros. Escolha **Confirmar** ou **Cancelar** na enquete. Também é possível responder diretamente à prévia com “pode registrar”, “cancelar” ou uma correção. Um “sim” sem responder à prévia não registra nada. Áudio serve para informar/corrigir o rascunho; não confirma uma gravação.

Se faltar informação, responda diretamente à pergunta do bot. Uma correção produz uma nova prévia e invalida a enquete anterior. A confirmação expira em 15 minutos, sem renovar o prazo a cada correção. Crédito, parcelas, outras moedas e outras datas não são convertidos automaticamente para débito/Pix.

Se perdeu a prévia, envie `/pendente` na mesma conversa. O bot recupera o pedido atual sem chamar a IA nem criar outra compra. Se a gravação estiver com resultado incerto, mantém o mesmo UUID e os mesmos itens.

## Isolamento e persistência

- Inicialmente somente `WHATSAPP_PURCHASE_OWNER_PHONE`, que deve ser a conta conectada, pode registrar suas próprias compras. Grupos e conversas com terceiros não acionam a IA.
- Mensagens do bot, alertas de água/dieta/financeiro e respostas a esses alertas são ignorados por este fluxo.
- O rascunho e os IDs ficam no volume ou PostgreSQL. Áudio e transcrição não ficam gravados no estado nem nos logs. Dados semânticos do rascunho são removidos após conclusão/expiração.
- No máximo seis chamadas à IA por minuto e sessenta por hora; áudio usa uma chamada de transcrição e outra de interpretação. Uma fila limitada serializa as mensagens.
- Áudio OGG/WAV/M4A de até 60 segundos e 5 MB. O dono, o destino e os metadados são verificados antes do download; o conteúdo é validado depois.
- Após um envio de confirmação com resultado incerto, os itens e o UUID ficam imutáveis. Uma nova confirmação consulta/reenvia o mesmo pedido, sem criar outro lançamento. O bot não declara cancelado um pedido que pode já ter sido registrado.
- Com a gravação confirmada e uma falha apenas no envio do recibo, repetir a confirmação reenvia o recibo salvo, sem nova gravação.

## Configuração

Worker: `GROQ_API_KEY`, `WHATSAPP_PURCHASE_ENABLED=true`, `WHATSAPP_PURCHASE_OWNER_PHONE`, `WHATSAPP_PURCHASE_CALLBACK_TOKEN` e `SUPERAPP_API_ORIGIN`. A chave Groq deve entrar somente no `env_file` do worker, com arquivo privado e fora do Git. Nunca no frontend, na imagem Docker ou no painel.

Backend do Super App: mesmo telefone e token dedicado, além do proprietário administrativo já configurado. `POST /api/financeiro?resource=whatsapp-purchases` exige Bearer, `confirmed:true`, UUID, telefone pinado, data e itens com centavos inteiros. O backend resolve o proprietário por configuração, nunca pelo texto do modelo. Reutiliza a confirmação atômica de compras existente; a chave Groq não é necessária na Vercel.

No modo volume da VPS não há SQL novo. No modo PostgreSQL aplicar `migrations/006_whatsapp_purchases.sql` depois das anteriores, antes de publicar o worker. O rollback recusa remover estado com pedido submetido ou rascunho válido. Para rollback de aplicação, desative o recurso e preserve o estado de compras/backup: versões antigas do painel não conhecem esse estado.

Modelos: `openai/gpt-oss-120b` para extração com JSON Schema estrito e `whisper-large-v3-turbo` para transcrição em português. A estrutura JSON não garante a exatidão dos dados; por isso existe validação e confirmação humana.

## Validação

Testes locais usam PostgreSQL embarcado e volume temporário, sem compras reais. Cobrem isolamento de dono, IDs, confirmação, correção, cancelamento, expiração, reinício, timeout, recibo perdido, limite de chamadas, áudio e contrato do callback. Os testes reais da Groq usam apenas frases fictícias e áudio sintético; não criam registros no Financeiro.
