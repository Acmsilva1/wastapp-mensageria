-- Aplicar manualmente depois das migrations 001 a 004. Nao apaga conversas ou historico.
begin;
alter table mensageria.deliveries add column if not exists replacement_address text;
alter table mensageria.deliveries add column if not exists replacement_message_ids jsonb not null default '[]';
alter table mensageria.deliveries add column if not exists superseded_at timestamptz;
alter table mensageria.deliveries add column if not exists delete_pending_ids jsonb not null default '[]';
alter table mensageria.deliveries add column if not exists delete_attempts integer not null default 0;
alter table mensageria.deliveries add column if not exists delete_next_at timestamptz;
alter table mensageria.deliveries add column if not exists delete_error text;
create index if not exists deliveries_replacement_current_idx on mensageria.deliveries(replacement_address,audience,event_type) where status='sent' and superseded_at is null;
create index if not exists deliveries_replacement_cleanup_idx on mensageria.deliveries(delete_next_at) where superseded_at is not null and delete_next_at is not null;
commit;
