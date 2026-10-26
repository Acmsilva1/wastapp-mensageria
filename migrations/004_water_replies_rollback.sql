-- Aplicacao parada. O rollback recusa remover correlacoes ainda validas.
begin;
do $$ begin
  if exists(select 1 from mensageria.deliveries where water_prompt is not null and created_at > now()-interval '48 hours') then
    raise exception 'Aguarde expirar os lembretes antes de remover as correlacoes';
  end if;
end $$;
drop index if exists mensageria.deliveries_water_reply_idx;
alter table mensageria.deliveries drop column if exists water_prompt;
alter table mensageria.deliveries drop column if exists water_address;
alter table mensageria.deliveries drop column if exists water_message_id;
commit;
