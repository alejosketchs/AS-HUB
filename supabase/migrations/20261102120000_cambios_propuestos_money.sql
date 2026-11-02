-- =====================================================================
-- AS HUB — Finanzas: cambios propuestos por "Money Admin" + movimientos ignorados
-- Proyecto Supabase "Suite Personal" (derzetuipyugmrjaxcyu)
--
-- Qué hace (no cambia ninguna fila existente):
--   1. finance_transactions.ignored (boolean, por defecto false). La app deja
--      fuera de totales, gráficas, presupuestos y saldo todo lo ignorado.
--   2. Tabla finance_change_requests: el bot (rol de servicio) propone un
--      cambio sobre un movimiento ya importado; el dueño lo aprueba o lo
--      rechaza desde la app.
--   3. RLS: solo el dueño autenticado (private.is_owner()) lee y cambia el
--      estado. anon no tiene nada. Insertar: solo el rol de servicio.
--   4. apply_change_request(request_id) y reject_change_request(request_id).
--
-- Correr DESPUÉS de la migración de seguridad (20261028120000_seguridad_sesion_rls.sql),
-- porque usa private.is_owner().
-- Vuelta atrás: está comentada al final de este archivo.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Movimientos ignorados
-- ---------------------------------------------------------------------
alter table public.finance_transactions
  add column if not exists ignored boolean not null default false;

comment on column public.finance_transactions.ignored is
  'true = no cuenta en totales, gráficas, presupuestos ni saldo (p. ej. transferencia entre cuentas propias)';

-- ---------------------------------------------------------------------
-- 2. Solicitudes de cambio
-- ---------------------------------------------------------------------
create table public.finance_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         text references public.profiles (id),
  transaction_id     uuid not null references public.finance_transactions (id) on delete cascade,
  change_type        text not null check (change_type in ('category', 'ignore', 'amount', 'description')),
  old_value          jsonb not null,
  new_value          jsonb not null,
  reason             text,
  save_merchant_rule boolean not null default false,
  status             text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'conflict')),
  created_by         text not null default 'money-admin',
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  -- La forma de new_value depende del tipo; así un INSERT mal armado falla de una vez.
  constraint finance_change_requests_new_value_shape check (
    case change_type
      when 'category'    then jsonb_typeof(new_value -> 'category_id') = 'string'
      when 'ignore'      then jsonb_typeof(new_value -> 'ignored') = 'boolean'
      when 'amount'      then jsonb_typeof(new_value -> 'amount') = 'number' and (new_value ->> 'amount')::numeric > 0
      when 'description' then jsonb_typeof(new_value -> 'description') = 'string'
    end
  ),
  constraint finance_change_requests_rule_only_category check (
    not save_merchant_rule or change_type = 'category'
  )
);

comment on table public.finance_change_requests is
  'Cambios que Money Admin propone sobre movimientos ya importados; el dueño los aprueba o rechaza en AS HUB. Ver docs/money-admin-cambios.md';

create index finance_change_requests_pending_idx
  on public.finance_change_requests (profile_id, created_at) where status = 'pending';
create index finance_change_requests_tx_idx
  on public.finance_change_requests (transaction_id);
-- Una sola propuesta pendiente por movimiento y tipo: si el bot repite, el INSERT falla.
create unique index finance_change_requests_one_pending
  on public.finance_change_requests (transaction_id, change_type) where status = 'pending';

-- ---------------------------------------------------------------------
-- 3. RLS y permisos
-- ---------------------------------------------------------------------
alter table public.finance_change_requests enable row level security;

revoke all on public.finance_change_requests from public, anon, authenticated;
grant select on public.finance_change_requests to authenticated;
grant update (status, decided_at) on public.finance_change_requests to authenticated;
grant select, insert, update, delete on public.finance_change_requests to service_role;

create policy owner_select on public.finance_change_requests
  for select to authenticated
  using ((select private.is_owner()));

create policy owner_update_status on public.finance_change_requests
  for update to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));

-- Sin política de INSERT/DELETE para authenticated: solo el rol de servicio
-- (que se salta RLS) crea solicitudes.

-- ---------------------------------------------------------------------
-- 4. Funciones
-- ---------------------------------------------------------------------

-- Misma normalización que la app y la ingesta (normMerchant en
-- supabase/functions/bancolombia-ingest/index.ts y finance.js):
--   s.trim().toUpperCase().replace(/\s+/g, ' ')
create or replace function private.merchant_key(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g'));
$$;
revoke all on function private.merchant_key(text) from public, anon;

-- Aplica una solicitud pendiente. Devuelve el estado final: 'applied' o 'conflict'
-- (o el estado que ya tenía, si no estaba pendiente).
-- p_save_rule: lo que marcó la persona en "Recordar para este comercio";
-- null = usar lo que propuso el bot (save_merchant_rule).
create or replace function public.apply_change_request(request_id uuid, p_save_rule boolean default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        public.finance_change_requests%rowtype;
  t        public.finance_transactions%rowtype;
  v_cat    uuid;
  v_sub    uuid;
  v_kind   text;
  v_spend  text;
  v_key    text;
  v_same   boolean;
begin
  if not (select private.is_owner()) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;

  select * into r from public.finance_change_requests where id = request_id for update;
  if not found then
    raise exception 'La solicitud % no existe', request_id using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    return r.status;
  end if;

  select * into t from public.finance_transactions where id = r.transaction_id for update;

  -- ¿El movimiento sigue como estaba cuando el bot lo leyó?
  v_same := case r.change_type
    when 'category' then
          (r.old_value ->> 'category_id')    is not distinct from t.category_id::text
      and (r.old_value ->> 'subcategory_id') is not distinct from t.subcategory_id::text
    when 'ignore'      then (r.old_value ->> 'ignored')::boolean is not distinct from t.ignored
    when 'amount'      then (r.old_value ->> 'amount')::numeric  is not distinct from t.amount
    when 'description' then (r.old_value ->> 'description')      is not distinct from t.description
  end;

  if not coalesce(v_same, false) then
    update public.finance_change_requests
      set status = 'conflict', decided_at = now()
      where id = r.id;
    return 'conflict';
  end if;

  if r.change_type = 'category' then
    v_cat := (r.new_value ->> 'category_id')::uuid;
    v_sub := nullif(r.new_value ->> 'subcategory_id', '')::uuid;

    select kind into v_kind from public.finance_categories where id = v_cat;
    if not found then
      raise exception 'La categoría % no existe', v_cat using errcode = '23503';
    end if;
    if v_sub is not null and not exists (
      select 1 from public.finance_subcategories where id = v_sub and category_id = v_cat
    ) then
      raise exception 'La subcategoría % no pertenece a la categoría %', v_sub, v_cat using errcode = '23503';
    end if;

    -- Igual que spendTypeFor() en finance.js: solo cambia en gastos.
    v_spend := t.spend_type;
    if t.type = 'expense' then
      v_spend := case
        when v_kind = 'fixed' then 'fixed'
        when v_sub is not null and exists (
          select 1 from public.budgets b
          where b.profile_id = t.profile_id and b.kind = 'fixed' and b.active
            and b.period <> 'week' and b.subcategory_id = v_sub
        ) then 'fixed'
        else 'variable'
      end;
    end if;

    update public.finance_transactions
      set category_id = v_cat, subcategory_id = v_sub, spend_type = v_spend
      where id = t.id;

    if coalesce(p_save_rule, r.save_merchant_rule) then
      v_key := private.merchant_key(t.description);
      if v_key <> '' then
        update public.finance_merchant_rules
          set category_id = v_cat, subcategory_id = v_sub
          where profile_id = t.profile_id and merchant_key = v_key;
        if not found then
          insert into public.finance_merchant_rules (profile_id, merchant_key, category_id, subcategory_id)
          values (t.profile_id, v_key, v_cat, v_sub);
        end if;
      end if;
    end if;

  elsif r.change_type = 'ignore' then
    update public.finance_transactions
      set ignored = (r.new_value ->> 'ignored')::boolean
      where id = t.id;

  elsif r.change_type = 'amount' then
    update public.finance_transactions
      set amount = (r.new_value ->> 'amount')::numeric
      where id = t.id;

  elsif r.change_type = 'description' then
    update public.finance_transactions
      set description = r.new_value ->> 'description'
      where id = t.id;
  end if;

  update public.finance_change_requests
    set status = 'applied',
        decided_at = now(),
        save_merchant_rule = (r.change_type = 'category' and coalesce(p_save_rule, r.save_merchant_rule))
    where id = r.id;
  return 'applied';
end;
$$;

create or replace function public.reject_change_request(request_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not (select private.is_owner()) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;

  update public.finance_change_requests
    set status = 'rejected', decided_at = now()
    where id = request_id and status = 'pending'
    returning status into v_status;
  if found then
    return v_status;
  end if;

  select status into v_status from public.finance_change_requests where id = request_id;
  if not found then
    raise exception 'La solicitud % no existe', request_id using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;

revoke all on function public.apply_change_request(uuid, boolean) from public, anon;
revoke all on function public.reject_change_request(uuid) from public, anon;
grant execute on function public.apply_change_request(uuid, boolean) to authenticated;
grant execute on function public.reject_change_request(uuid) to authenticated;

-- Para que la app se entere al instante cuando el bot propone algo (si existe la publicación de Realtime).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.finance_change_requests';
  end if;
end $$;

commit;

-- =====================================================================
-- VUELTA ATRÁS (rollback) — copiar sin los "-- " y correr en el SQL Editor.
-- Ojo: borra las solicitudes y la marca "ignorado" de los movimientos
-- (los movimientos ignorados vuelven a contar en los totales).
-- =====================================================================
-- begin;
-- drop function if exists public.apply_change_request(uuid, boolean);
-- drop function if exists public.reject_change_request(uuid);
-- drop function if exists private.merchant_key(text);
-- drop table if exists public.finance_change_requests;   -- también la saca de Realtime
-- alter table public.finance_transactions drop column if exists ignored;
-- commit;
