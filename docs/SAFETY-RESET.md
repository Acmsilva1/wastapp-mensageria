# Reset de segurança

O painel autenticado oferece **Reiniciar e limpar fila** para recuperar o worker quando a fila operacional estiver travada.

O comando cancela entregas `pending`, marca entregas `sending` como `uncertain` e remove o conteúdo ainda armazenado nessas entregas. Também cancela rascunhos de compra nos estados `draft`, `clarification`, `preparing` e `submitting`, removendo itens e valores do cache. Em seguida, o worker encerra com código de falha para que a política `restart: unless-stopped` do Docker o inicie novamente.

O reset preserva destinatários, permissões, histórico de entregas, compras já confirmadas, canal de agentes e os arquivos de sessão do WhatsApp. Ele não executa logout, não remove o pareamento e não gera QR Code. Se uma compra estava em `submitting`, é necessário conferir o Super App antes de lançá-la novamente, pois a resposta da gravação anterior pode ter sido perdida.

O endpoint exige sessão administrativa, origem válida, `X-Panel-Request: 1` e a confirmação literal `reset_worker_and_queue`. Repetir a solicitação enquanto ela está pendente reutiliza o mesmo comando.

Se o processo estiver completamente bloqueado e não conseguir consultar o armazenamento compartilhado, o botão não substitui um reinício administrativo do container pela VPS.
