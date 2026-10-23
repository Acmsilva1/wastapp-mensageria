-- DESTRUTIVO: executar somente com backup e autorizacao explicita.
-- Remove apenas os objetos desta migration. A aplicacao deve estar parada.
begin;
drop table if exists mensageria.login_limits;
drop table if exists mensageria.connection_logs;
drop table if exists mensageria.session_backups;
drop table if exists mensageria.deliveries;
drop table if exists mensageria.ingress;
drop table if exists mensageria.connection_state;
drop table if exists mensageria.recipients;
drop schema if exists mensageria;
commit;
