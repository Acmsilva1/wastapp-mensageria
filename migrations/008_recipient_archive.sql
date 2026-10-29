-- Necessária somente para instalações PostgreSQL. A VPS usa o repositório em volume.
begin;
alter table mensageria.recipients add column if not exists deleted_at timestamptz;
commit;
