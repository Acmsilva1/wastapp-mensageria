-- Executar manualmente depois de 001 e 002. Sem envio ou exclusao de destinatarios.
begin;
alter table mensageria.recipients alter column phone drop not null;
alter table mensageria.recipients add column if not exists target_type text not null default 'phone';
alter table mensageria.recipients add column if not exists group_id text;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='mensageria.recipients'::regclass and conname='recipients_target_check') then
    alter table mensageria.recipients add constraint recipients_target_check check (
      (target_type='phone' and phone is not null and group_id is null) or
      (target_type='group' and phone is null and group_id is not null and length(group_id)<=100 and group_id ~ '^[0-9]+(-[0-9]+)?@g[.]us$')
    );
  end if;
  if not exists(select 1 from pg_constraint where conrelid='mensageria.recipients'::regclass and conname='recipients_group_audience_key') then
    alter table mensageria.recipients add constraint recipients_group_audience_key unique(group_id,audience);
  end if;
end $$;
create table if not exists mensageria.group_catalog (
  id text primary key check(length(id)<=100 and id ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
  name text not null check(length(name) between 1 and 200),
  worker_id uuid not null,
  updated_at timestamptz not null default now()
);
alter table mensageria.group_catalog enable row level security;
revoke all on mensageria.group_catalog from public;
commit;
