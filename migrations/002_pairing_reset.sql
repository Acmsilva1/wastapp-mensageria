-- Executar manualmente no mesmo banco da migration 001, antes do deploy.
-- Apenas controle de pareamento; nao remove destinatarios, historico ou mensagens.
begin;
alter table mensageria.connection_state add column if not exists pairing_request_id uuid;
alter table mensageria.connection_state add column if not exists pairing_completed_id uuid;
commit;
