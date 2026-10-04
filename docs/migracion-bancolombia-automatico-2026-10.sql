-- AS FINANZAS · ingesta automática de alertas Bancolombia (octubre 2026)
-- Ya aplicada en Supabase (proyecto derzetuipyugmrjaxcyu) vía MCP; se deja aquí
-- como registro, igual que migracion-finanzas-copiloto-2026-09.sql.

-- 1. Columnas de origen/auditoria en finance_transactions
alter table finance_transactions
  add column if not exists source text not null default 'manual' check (source in ('manual','automatico')),
  add column if not exists source_message_id text,
  add column if not exists source_raw_text text;

comment on column finance_transactions.source is 'manual = capturado en la app, automatico = creado por la ingesta de alertas Bancolombia';
comment on column finance_transactions.source_message_id is 'Gmail message id del correo que origino el movimiento automatico (auditoria)';
comment on column finance_transactions.source_raw_text is 'Texto original del correo del banco, para poder auditar el movimiento automatico';

-- 2. Mapeo editable de ultimos 4 digitos (tarjeta o cuenta) -> perfil
create table if not exists finance_card_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references profiles(id) on delete cascade,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  label text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists finance_card_profiles_last4_idx on finance_card_profiles (last4) where active;

alter table finance_card_profiles enable row level security;
drop policy if exists anon_all on finance_card_profiles;
create policy anon_all on finance_card_profiles for all using (true) with check (true);

-- 3. Bandeja de correos del banco: cola de ingesta, nunca inventa datos
create table if not exists finance_email_inbox (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  received_at timestamptz,
  subject text not null default '',
  raw_text text not null,
  status text not null default 'pending_review' check (status in ('pending_review','applied','ignored')),
  parsed jsonb,
  profile_id text references profiles(id),
  transaction_id uuid references finance_transactions(id),
  created_at timestamptz not null default now()
);
create index if not exists finance_email_inbox_status_idx on finance_email_inbox (status);

alter table finance_email_inbox enable row level security;
drop policy if exists anon_all on finance_email_inbox;
create policy anon_all on finance_email_inbox for all using (true) with check (true);
