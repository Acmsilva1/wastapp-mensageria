# Compras por texto e áudio

O worker da mensageria interpreta compras com Groq. A chave `GROQ_API_KEY` fica somente no ambiente do worker da VPS. O Super App recebe dados estruturados e confirmados, valida e registra no Financeiro com idempotência. A Groq não recebe chaves de banco ou do Super App.

## Uso

No painel, edite o destinatário e marque **Enviar compras por texto ou áudio, com confirmação**. Depois, a pessoa autorizada envia uma mensagem individual ao número conectado. O próprio número conectado pode usar a conversa consigo mesmo, desde que também esteja autorizado. Exemplos:

- “Gastei 10 reais na padaria.”
- “Almoço quinze reais e café cinco reais.”

O bot mostra descrição, valores, total, data de hoje e o destino Despesas variáveis · Débito/Pix. Descrição e valor bastam: não pergunta pagamento ou categoria. Internamente o Super App recebe `metodo_pagamento=debito_pix`, `tipo=despesa` e os demais campos padrão; as despesas fixas permanecem separadas. As perguntas e orientações usam o mascote 🦉. Selecione **Sim** ou **Não** na enquete, na própria conversa. Também é possível responder diretamente à prévia com “pode registrar”, “cancelar” ou uma correção. Um “sim” sem responder à prévia não registra nada. Áudio serve para informar/corrigir o rascunho; não confirma uma gravação.

Se faltar informação, responda diretamente à pergunta do bot. Uma correção em resposta à prévia produz uma nova versão e invalida a enquete anterior. Uma nova mensagem independente encerra o rascunho ainda não enviado e permite iniciar outra despesa, sem cancelamento manual. Mensagens de água, ecos do bot e respostas a outros alertas permanecem isolados. Pedidos já enviados com resultado incerto continuam protegidos e não são substituídos. A confirmação expira em 15 minutos, sem renovar o prazo a cada correção. Crédito, parcelas, outras moedas e outras datas não são convertidos automaticamente para débito/Pix.

Se ficou na antiga pergunta sobre débito ou Pix, envie `/pendente`: o bot recupera descrição e valor, aplica a modalidade única e mostra a prévia sem IA nova. Pedidos já submetidos continuam com o payload original, para preservar a idempotência.

Se perdeu a prévia, envie `/pendente` na mesma conversa. O bot recupera o pedido atual sem chamar a IA nem criar outra compra. Se a gravação estiver com resultado incerto, mantém o mesmo UUID e os mesmos itens.

## Isolamento e persistência

- Só pessoas ativas com a permissão `purchases.record` podem iniciar compras. Receber alertas financeiros não concede essa permissão. Grupos não acionam compras. Cada telefone deve ter apenas um cadastro com essa permissão; vínculos ambíguos são recusados.
- Todas as compras entram na conta financeira administrativa configurada no Super App; o perfil do destinatário continua determinando somente o destino dos indicadores de saúde. A autoria financeira mantém o telefone real do remetente.
- Cada pessoa possui rascunho, IDs e limites independentes. A autorização é conferida antes da IA, do download, da publicação e da confirmação. A Vercel consulta a autorização online na mensageria antes de acessar os registros financeiros. Revogar/desativar bloqueia novas confirmações; editar ou reativar invalida as prévias antigas. Pedidos já submetidos com resultado incerto mantêm UUID e itens; após reautorizar, use `/pendente` para gerar uma nova prévia e confirme o mesmo pedido sem duplicar.
- A opção única **Água** inclui receber os lembretes e registrar o consumo ao responder no perfil vinculado. Não exige IA. Em destinatários individuais, a autorização de água acompanha essa opção, inclusive nos cadastros existentes; a flag interna `water.record` é mantida somente por compatibilidade. Compras continuam exigindo permissão separada.
- Mensagens do bot, alertas de água/dieta/financeiro e respostas a esses alertas são ignorados por este fluxo.
- O rascunho e os IDs ficam no volume ou PostgreSQL. Áudio e transcrição não ficam gravados no estado nem nos logs. Dados semânticos do rascunho são removidos após conclusão/expiração.
- Por pessoa, no máximo seis chamadas à IA por minuto e sessenta por hora; áudio usa uma chamada de transcrição e outra de interpretação. Uma fila limitada serializa as mensagens.
- Áudio OGG/WAV/M4A de até 60 segundos e 5 MB. A autorização, o destino e os metadados são verificados antes do download; o conteúdo é validado depois.
- Após um envio de confirmação com resultado incerto, os itens e o UUID ficam imutáveis. Uma nova confirmação consulta/reenvia o mesmo pedido, sem criar outro lançamento. O bot não declara cancelado um pedido que pode já ter sido registrado.
- Com a gravação confirmada e uma falha apenas no envio do recibo, repetir a confirmação reenvia o recibo salvo, sem nova gravação.

## Configuração

Worker: `GROQ_API_KEY`, `WHATSAPP_PURCHASE_ENABLED=true`, `WHATSAPP_PURCHASE_OWNER_PHONE`, `WHATSAPP_PURCHASE_CALLBACK_TOKEN` e `SUPERAPP_API_ORIGIN`. A chave Groq deve entrar somente no `env_file` do worker, com arquivo privado e fora do Git. Nunca no frontend, na imagem Docker ou no painel.

Backend do Super App: mesmo telefone e token dedicado, além do proprietário administrativo já configurado. `POST /api/financeiro?resource=whatsapp-purchases` exige Bearer, `confirmed:true`, UUID, telefone real do remetente, `authorization_id`, `authorization_version`, data e itens com centavos inteiros. O backend resolve o proprietário por configuração, nunca pelo texto do modelo. Reutiliza a confirmação atômica de compras existente; a chave Groq não é necessária na Vercel.

No modo volume da VPS não há SQL novo. No modo PostgreSQL aplicar `migrations/006_whatsapp_purchases.sql` e `migrations/007_interaction_permissions.sql` depois das anteriores, antes de publicar painel e worker. Novos cadastros começam sem permissões de interação. O rollback 007 recusa apagar permissões ainda existentes.

O endpoint interno `POST /api/control?action=interaction-authorize` usa somente o token de integração já existente, valida remetente, ID e versão da autorização e não retorna lista de destinatários. A Vercel usa `WHATSAPP_API_ORIGIN` e `WHATSAPP_INTEGRATION_TOKEN` existentes para consultá-lo. Sem autorização válida ou com a mensageria indisponível, não grava. Publique as duas pontas em conjunto. Não é necessário instalar modelo local ou compartilhar a chave Groq com o painel. O rollback recusa remover estado com pedido submetido ou rascunho válido. Para rollback de aplicação, desative o recurso e preserve o estado de compras/backup: versões antigas do painel não conhecem esse estado.

Modelos: `openai/gpt-oss-120b` para extração com JSON Schema estrito e `whisper-large-v3-turbo` para transcrição em português. A estrutura JSON não garante a exatidão dos dados; por isso existe validação e confirmação humana.

## Validação

Testes locais usam PostgreSQL embarcado e volume temporário, sem compras reais. Cobrem isolamento de dono, IDs, confirmação, correção, cancelamento, expiração, reinício, timeout, recibo perdido, limite de chamadas, áudio e contrato do callback. Os testes reais da Groq usam apenas frases fictícias e áudio sintético; não criam registros no Financeiro.

## Diagnóstico de áudio

O download de voz informa o MIME real ao WhatsApp: o SDK 1.34.7 omite esse campo e versões atuais do WhatsApp podem recusar PTT como `application/octet-stream`. A compatibilidade mantém limites de formato, duração e tamanho, sem retornar chaves ou URLs de mídia do navegador.

Falhas de download, transcrição e interpretação têm orientações distintas. Os logs guardam apenas códigos técnicos permitidos (`purchase_audio_download_failed`, `purchase_transcription_failed`, etc.), sem áudio, transcrição, telefone ou resposta bruta do provedor.
