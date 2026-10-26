begin;
alter table mensageria.recipients add column if not exists permissions text[] not null default '{}';
alter table mensageria.recipients drop constraint if exists recipients_events_check;
alter table mensageria.recipients add constraint recipients_events_check check (
  cardinality(events) between 0 and 3
  and events <@ array['health.water_progress','health.diet_menu','financeiro.daily_summary']::text[]
);
alter table mensageria.recipients drop constraint if exists recipients_permissions_check;
alter table mensageria.recipients add constraint recipients_permissions_check check (
  cardinality(permissions) between 0 and 2
  and permissions <@ array['water.record','purchases.record']::text[]
  and (target_type='phone' or cardinality(permissions)=0)
  and (not ('water.record'=any(permissions)) or 'health.water_progress'=any(events))
  and cardinality(events)+cardinality(permissions)>0
);
commit;
