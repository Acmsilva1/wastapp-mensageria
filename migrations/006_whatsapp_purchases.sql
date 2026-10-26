-- Aplicar manualmente no modo PostgreSQL. O worker no modo volume nao precisa de SQL.
begin;
create table if not exists mensageria.purchase_state (
 id integer primary key check(id=1),
 data jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
insert into mensageria.purchase_state(id) values(1) on conflict do nothing;
alter table mensageria.purchase_state enable row level security;
revoke all on mensageria.purchase_state from public;
commit;
