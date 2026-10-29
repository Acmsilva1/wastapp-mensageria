# Exclusão do lembrete e da enquete

Correção de 29/10/2026, limitada ao adaptador `worker/message-replacement.mjs`.

## Causa confirmada

O conjunto de substituição já registrava o ID do texto e o ID da enquete. Na execução real, os textos antigos desapareciam, mas as enquetes permaneciam com tipo `poll_creation`, apesar de a fila de exclusão estar marcada como concluída. `Cmd.sendRevokeMsgs` apenas disparava um evento e não fornecia confirmação de revogação da enquete.

## Comportamento corrigido

- Enquetes de autoria do bot usam a ação aguardável `WAWebRevokeMsgAction.sendRevoke`, após validar ID, conversa individual e permissão de revogação.
- O resultado precisa ser `OK`; o modelo deve desaparecer ou mudar para `revoked`. Sem confirmação, o item permanece sujeito ao retry existente, sem falso sucesso.
- A exclusão local continua restrita à própria conversa da conta conectada. Não há fallback de exclusão local em conversas de terceiros.
- Mensagens de usuários, grupos, enquetes atuais e registro de consumo de água permanecem fora da limpeza.
- Não há varredura nem exclusão geral de conversa: são usados somente IDs persistidos dos conjuntos anteriores concluídos.

## Validação e publicação

Os 17 testes focados e os 119 testes completos passaram, assim como a verificação de sintaxe. Houve comprovação real com uma enquete antiga já substituída: retorno `OK` e ausência posterior no modelo do WhatsApp.

A imagem corretiva foi criada a partir da imagem já em execução, substituindo apenas esse módulo, sem atualizar Node, Chromium ou dependências. O fingerprint de sessão foi comparado e permaneceu igual. Um primeiro rollback preventivo ocorreu por comparação de hash com normalização CRLF/LF; a publicação seguinte conferiu os bytes exatos e reconectou à mesma conta.

Backup privado na VPS: `/root/mensageria-backups/poll-delete-20261029t093827z`. O volume de pareamento foi preservado, e não foi solicitado novo QR Code. As enquetes antigas ainda existentes, de conjuntos já marcados como substituídos, foram recolocadas na fila da limpeza corrigida; enquetes atuais não entram nessa reparação.

A ação interna do WhatsApp pode mudar em versões futuras. Se não estiver disponível ou se a confirmação falhar, o adaptador retorna falha transitória e não marca a exclusão como concluída.

## Conferência final na VPS

A fila corretiva de 55 enquetes antigas terminou sem erros. A leitura posterior do modelo do WhatsApp confirmou zero enquetes antigas restantes nesse conjunto e preservação das três enquetes atuais conferidas. O worker ficou conectado à mesma conta, e os domínios da mensageria e da central responderam HTTPS 200. A evidência privada está em verification.json no diretório do backup citado acima.
