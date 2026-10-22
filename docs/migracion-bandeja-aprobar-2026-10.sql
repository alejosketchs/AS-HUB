-- AS FINANZAS · aprobar alertas de la bandeja de forma atómica (octubre 2026)
-- Ya aplicada en Supabase (proyecto derzetuipyugmrjaxcyu) vía MCP; se deja aquí
-- como registro, igual que las otras migraciones de docs/.

-- 1. Un correo del banco nunca puede originar dos movimientos.
create unique index if not exists finance_transactions_source_message_id_uidx
  on finance_transactions (source_message_id) where source_message_id is not null;

-- 2. Aprueba UNA fila de la bandeja: inserta el movimiento y marca la fila como
--    applied en la misma transacción. Los campos de origen (source, fecha, hora,
--    texto del correo) salen siempre de la fila de la bandeja, no del cliente.
--    p_tx trae lo editable: profile_id, type, amount, category_id, subcategory_id,
--    goal_id, description, reimbursable, reimburse_by.
--    Si ya existe un movimiento con ese source_message_id no se inserta otro:
--    solo se enlaza la fila a ese movimiento. Devuelve el id del movimiento.
create or replace function finance_inbox_apply(p_inbox_id uuid, p_tx jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_inbox finance_email_inbox%rowtype;
  v_tx_id uuid;
  v_type text := p_tx->>'type';
  v_cat uuid := nullif(p_tx->>'category_id', '')::uuid;
  v_kind text;
  v_spend text;
  v_reimb boolean := coalesce((p_tx->>'reimbursable')::boolean, false) and v_type = 'expense';
begin
  select * into v_inbox from finance_email_inbox where id = p_inbox_id for update;
  if not found then raise exception 'Fila de bandeja no encontrada'; end if;
  if v_inbox.status <> 'pending_review' then raise exception 'La fila ya no está pendiente (%)', v_inbox.status; end if;

  select id into v_tx_id from finance_transactions where source_message_id = v_inbox.gmail_message_id;
  if v_tx_id is null then
    select kind into v_kind from finance_categories where id = v_cat;
    v_spend := case
      when v_type = 'income' then 'income'
      when v_type in ('saving', 'withdrawal') then 'saving'
      when v_kind = 'fixed' then 'fixed'
      else 'variable' end;

    insert into finance_transactions (
      profile_id, type, amount, transaction_date, occurred_at, category_id, subcategory_id, goal_id,
      spend_type, description, reimbursable, reimburse_by,
      source, source_message_id, source_raw_text)
    values (
      p_tx->>'profile_id', v_type, (p_tx->>'amount')::numeric,
      coalesce(nullif(p_tx->>'transaction_date', '')::date, (v_inbox.received_at at time zone 'America/Bogota')::date),
      v_inbox.received_at, v_cat, nullif(p_tx->>'subcategory_id', '')::uuid, nullif(p_tx->>'goal_id', '')::uuid,
      v_spend, coalesce(p_tx->>'description', ''), v_reimb, case when v_reimb then coalesce(p_tx->>'reimburse_by', '') else '' end,
      'automatico', v_inbox.gmail_message_id, v_inbox.raw_text)
    returning id into v_tx_id;
  end if;

  update finance_email_inbox
    set status = 'applied', transaction_id = v_tx_id, profile_id = coalesce(p_tx->>'profile_id', profile_id)
    where id = p_inbox_id;
  return v_tx_id;
end;
$$;

-- 3. Aprueba en lote las filas pendientes listas (profile_id, amount y
--    category_id en parsed). Todo en una sola transacción: o quedan todas o
--    ninguna. Las que no estén listas no se tocan y se devuelven como skipped.
create or replace function finance_inbox_apply_batch(p_inbox_ids uuid[])
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r finance_email_inbox%rowtype;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  for r in select * from finance_email_inbox where id = any(p_inbox_ids) order by received_at for update loop
    if r.status <> 'pending_review' or r.profile_id is null or r.parsed is null
       or coalesce((r.parsed->>'amount')::numeric, 0) <= 0
       or nullif(r.parsed->>'category_id', '') is null
       or coalesce(r.parsed->>'type', '') not in ('income', 'expense') then
      v_skipped := v_skipped || to_jsonb(r.id);
      continue;
    end if;
    perform finance_inbox_apply(r.id, jsonb_build_object(
      'profile_id', r.profile_id,
      'type', r.parsed->>'type',
      'amount', r.parsed->>'amount',
      'category_id', r.parsed->>'category_id',
      'subcategory_id', r.parsed->>'subcategory_id',
      'description', r.parsed->>'description',
      'reimbursable', coalesce(r.parsed->>'reimbursable', 'false'),
      'reimburse_by', r.parsed->>'reimburse_by'));
    v_applied := v_applied || to_jsonb(r.id);
  end loop;
  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end;
$$;

grant execute on function finance_inbox_apply(uuid, jsonb) to anon, authenticated;
grant execute on function finance_inbox_apply_batch(uuid[]) to anon, authenticated;

-- 4. Tarjetas/cuentas de Alejo para la ingesta automática.
insert into finance_card_profiles (profile_id, last4, label)
select v.* from (values
  ('alejo', '5076', 'Tarjeta débito compras'),
  ('alejo', '8213', 'Cuenta ahorros'),
  ('alejo', '1887', 'T. crédito Mastercard')) as v(profile_id, last4, label)
where not exists (select 1 from finance_card_profiles c where c.last4 = v.last4 and c.profile_id = v.profile_id);
