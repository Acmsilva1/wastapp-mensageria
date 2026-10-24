-- Restaurar primeiro o codigo anterior a 003. Recusa reverter se existem destinatarios grupo.
-- Decida manualmente o destino desses registros, sem apagar historico inadvertidamente.
begin;
do $$ begin
  if exists(select 1 from mensageria.recipients where target_type='group') then
    raise exception 'group_recipients_exist: rollback recusado para preservar destinatarios';
  end if;
end $$;
drop table if exists mensageria.group_catalog;
alter table mensageria.recipients drop constraint if exists recipients_group_audience_key;
alter table mensageria.recipients drop constraint if exists recipients_target_check;
alter table mensageria.recipients drop column if exists group_id;
alter table mensageria.recipients drop column if exists target_type;
alter table mensageria.recipients alter column phone set not null;
commit;
