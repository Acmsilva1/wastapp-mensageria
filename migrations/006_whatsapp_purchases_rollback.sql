-- Aplicacao parada. Nao remove registros financeiros do Super App.
begin;
do $$ begin
 if exists(select 1 from mensageria.purchase_state where data->'draft'->>'status'='submitting' or (data->'draft'->>'status' in ('draft','clarification') and (data->'draft'->>'expires_at')::timestamptz>now())) then
  raise exception 'Resolva ou aguarde os rascunhos pendentes antes de reverter';
 end if;
end $$;
drop table mensageria.purchase_state;
commit;
