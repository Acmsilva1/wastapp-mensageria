-- Reverter somente apos restaurar uma versao do codigo anterior a 002.
begin;
alter table mensageria.connection_state drop column if exists pairing_request_id;
alter table mensageria.connection_state drop column if exists pairing_completed_id;
commit;
