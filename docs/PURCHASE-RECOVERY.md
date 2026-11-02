# Recuperação de gastos

O worker verifica pedidos `submitting` a cada 30 segundos enquanto conectado, inclusive após reiniciar. Só repete pedidos já confirmados, com UUID e itens originais, após revalidar a permissão e sua versão. Nunca confirma rascunhos automaticamente.

Falhas transitórias são persistidas com última tentativa, contador e próxima tentativa: 30 s, 60 s, 120 s, até o limite de 15 minutos. A repetição automática não envia avisos a cada falha; o recibo é enviado quando houver confirmação.

Conflito, data expirada, autorização recusada e dados inválidos deixam o pedido `blocked`, sem repetição automática. O painel autenticado mostra o motivo e as tentativas, sem conteúdo da compra. Confira o Super App antes de limpar uma pendência com o reset de segurança, pois o pedido pode já ter sido gravado.

Timeout ou resposta incoerente permanecem incertos: nunca são descartados por tempo e a repetição usa o contrato idempotente do Super App. Revogação de permissão impede a recuperação; não se adotam automaticamente novas versões de autorização durante recuperação em segundo plano.
