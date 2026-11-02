-- =====================================================================
-- AS Suite — Seguridad: sesión real (Supabase Auth) + RLS solo para el dueño
-- Proyecto Supabase "Suite Personal" (derzetuipyugmrjaxcyu)
--
-- Qué hace (sin borrar ni cambiar ninguna fila de datos):
--   1. Crea el esquema `private` con la lista de dueños (private.owners)
--      y la función private.is_owner(). Agrega as.dibujo@gmail.com.
--   2. Borra TODAS las políticas abiertas (USING true / rol anon) y deja
--      una sola política por tabla: rol authenticated + is_owner().
--   3. Quita a `anon` todos los permisos sobre tablas, secuencias y
--      funciones de `public`, también para tablas futuras.
--   4. Cierra las funciones de la bandeja Bancolombia a anon y arregla
--      el search_path mutable.
--
-- El service role (edge function bancolombia-ingest) se salta RLS, así que
-- la ingesta automática sigue funcionando igual.
--
-- Correr DESPUÉS de la migración del PR #2 (migracion-bandeja-aprobar-2026-10.sql),
-- porque esa vuelve a dar `grant execute ... to anon`.
-- Vuelta atrás: supabase/migrations/rollback/20261028120000_seguridad_sesion_rls_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Dueños
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists private.owners (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now()
);
revoke all on private.owners from public, anon, authenticated;

insert into private.owners (user_id, email)
select id, email from auth.users where lower(email) = 'as.dibujo@gmail.com'
on conflict (user_id) do nothing;

-- Si el usuario no existe, se aborta todo: sin dueño nadie podría entrar.
do $$
begin
  if not exists (select 1 from private.owners) then
    raise exception 'No hay dueño en private.owners: revisa que as.dibujo@gmail.com exista en auth.users';
  end if;
end $$;

-- SECURITY DEFINER para poder leer private.owners sin dar acceso a la tabla.
-- search_path vacío: todo va con esquema explícito.
create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.owners o where o.user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Políticas: fuera las abiertas, una sola "solo el dueño" por tabla
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  p record;
  tablas text[] := array[
    -- AS HUB
    'profiles', 'sessions', 'suite_data',
    'tasks', 'task_projects', 'agenda_events', 'notes',
    'finance_categories', 'finance_subcategories', 'finance_transactions',
    'budgets', 'budget_checks', 'debts', 'savings_goals',
    'finance_card_profiles', 'finance_email_inbox', 'finance_merchant_rules',
    'finance_profile_data',
    -- AS Reader
    'reader_users', 'reader_books', 'reader_logs', 'reader_unlocks',
    'reader_glossary', 'reader_quotes', 'reader_push_subs', 'reader_push_sent'
  ];
begin
  foreach t in array tablas loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated '
      'using ((select private.is_owner())) with check ((select private.is_owner()))', t);
  end loop;
end $$;

-- user_suite_data ya estaba bien (user_id = auth.uid()); se deja igual.

-- ---------------------------------------------------------------------
-- 3. Permisos: anon no toca nada de public (hoy ni mañana)
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------
-- 4. Funciones
-- ---------------------------------------------------------------------
-- RPC que usa la app al aprobar la bandeja: solo con sesión (y RLS aplica,
-- porque son SECURITY INVOKER).
grant execute on function public.finance_inbox_apply(uuid, jsonb) to authenticated;
grant execute on function public.finance_inbox_apply_batch(uuid[]) to authenticated;

-- Funciones de trigger: nadie necesita llamarlas por la API. El trigger
-- sigue disparando igual (Postgres no revisa EXECUTE al disparar).
revoke execute on function public.finance_email_inbox_on_tx_delete() from authenticated;
revoke execute on function public.touch_updated_at() from authenticated;

-- search_path fijo (aviso 0011 del linter).
alter function public.touch_updated_at() set search_path = '';
alter function public.finance_email_inbox_on_tx_delete() set search_path = public;
alter function public.finance_inbox_apply(uuid, jsonb) set search_path = public;
alter function public.finance_inbox_apply_batch(uuid[]) set search_path = public;

commit;
