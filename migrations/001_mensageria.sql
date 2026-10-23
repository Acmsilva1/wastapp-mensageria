-- Executar manualmente no SQL Editor do Supabase. Nao executado automaticamente.
-- Use o mesmo usuario PostgreSQL no backend ou conceda acesso somente ao papel de servico escolhido.
begin;
create schema if not exists mensageria;
revoke all on schema mensageria from public;

create table if not exists mensageria.recipients (
  id uuid primary key,
  name text not null check (length(name) between 1 and 80),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  audience text not null check (audience ~ '^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$'),
  events text[] not null check (cardinality(events) between 1 and 3 and events <@ array['health.water_progress','health.diet_menu','financeiro.daily_summary']::text[]),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(phone, audience)
);
create table if not exists mensageria.ingress (
  source text not null,
  idempotency_key text not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  primary key(source, idempotency_key)
);
create table if not exists mensageria.deliveries (
  id uuid primary key,
  source text not null,
  idempotency_key text not null,
  recipient_id uuid not null references mensageria.recipients(id),
  audience text not null,
  event_type text not null,
  title text not null,
  message text,
  status text not null default 'pending' check(status in ('pending','sending','sent','failed','uncertain','cancelled')),
  worker_id uuid,
  whatsapp_id text,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key(source, idempotency_key) references mensageria.ingress(source,idempotency_key),
  unique(source,idempotency_key,recipient_id)
);
create index if not exists deliveries_pending_idx on mensageria.deliveries(created_at) where status='pending';
create table if not exists mensageria.connection_state (
  id integer primary key check(id=1),
  worker_id uuid,
  lease_until timestamptz,
  status text not null default 'offline',
  account_name text,
  account_phone text,
  qr_encrypted bytea,
  qr_expires_at timestamptz,
  session_saved_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into mensageria.connection_state(id) values(1) on conflict do nothing;
create table if not exists mensageria.session_backups (
  name text primary key,
  encrypted_archive bytea not null check(octet_length(encrypted_archive)<=134217728),
  updated_at timestamptz not null default now()
);
create table if not exists mensageria.connection_logs (
  id bigint generated always as identity primary key,
  event text not null check(length(event)<=60),
  code text check(length(code)<=80),
  worker_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists connection_logs_date_idx on mensageria.connection_logs(created_at desc);
create table if not exists mensageria.login_limits (
  fingerprint text primary key,
  attempts integer not null default 1,
  expires_at timestamptz not null
);

-- Defesa adicional: sem acesso pelo frontend/REST. O backend acessa PostgreSQL diretamente.
alter table mensageria.recipients enable row level security;
alter table mensageria.ingress enable row level security;
alter table mensageria.deliveries enable row level security;
alter table mensageria.connection_state enable row level security;
alter table mensageria.session_backups enable row level security;
alter table mensageria.connection_logs enable row level security;
alter table mensageria.login_limits enable row level security;
revoke all on all tables in schema mensageria from public;
revoke all on all sequences in schema mensageria from public;
-- Nao adicionar mensageria aos schemas expostos da API Supabase.
commit;
