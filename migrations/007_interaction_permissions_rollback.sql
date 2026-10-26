begin;
do $$ begin
  if exists(select 1 from mensageria.recipients where cardinality(permissions)>0 or cardinality(events)=0) then
    raise exception 'interaction_permissions_exist: revogue as permissoes e revise os destinatarios antes do rollback';
  end if;
end $$;
alter table mensageria.recipients drop constraint recipients_permissions_check;
alter table mensageria.recipients drop column permissions;
alter table mensageria.recipients drop constraint recipients_events_check;
alter table mensageria.recipients add constraint recipients_events_check check (
  cardinality(events) between 1 and 3
  and events <@ array['health.water_progress','health.diet_menu','financeiro.daily_summary']::text[]
);
commit;
