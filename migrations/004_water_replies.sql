-- Aplicar manualmente depois de 001, 002 e 003, antes de publicar o codigo.
begin;
alter table mensageria.deliveries add column if not exists water_prompt jsonb;
alter table mensageria.deliveries add column if not exists water_address text;
alter table mensageria.deliveries add column if not exists water_message_id text;
create index if not exists deliveries_water_reply_idx on mensageria.deliveries(whatsapp_id) where water_prompt is not null;
commit;
