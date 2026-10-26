-- Aplicacao parada. Nao remover IDs enquanto houver exclusoes pendentes ou alertas interativos validos.
begin;
do $$ begin
 if exists(select 1 from mensageria.deliveries where jsonb_array_length(delete_pending_ids)>0 or (replacement_address is not null and created_at>now()-interval '48 hours')) then
  raise exception 'Exporte e resolva pendencias/aguarde expirar alertas antes de reverter';
 end if;
end $$;
drop index if exists mensageria.deliveries_replacement_current_idx;
drop index if exists mensageria.deliveries_replacement_cleanup_idx;
alter table mensageria.deliveries drop column if exists replacement_address;
alter table mensageria.deliveries drop column if exists replacement_message_ids;
alter table mensageria.deliveries drop column if exists superseded_at;
alter table mensageria.deliveries drop column if exists delete_pending_ids;
alter table mensageria.deliveries drop column if exists delete_attempts;
alter table mensageria.deliveries drop column if exists delete_next_at;
alter table mensageria.deliveries drop column if exists delete_error;
commit;
