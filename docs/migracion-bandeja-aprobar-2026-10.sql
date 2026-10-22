-- AS FINANZAS · aprobar la bandeja de Bancolombia (octubre 2026)
--
-- Este archivo NO se aplica solo. Hay que correrlo a mano en el SQL editor
-- de Supabase (proyecto Suite Personal, derzetuipyugmrjaxcyu).
-- Se puede volver a correr: reemplaza las funciones y no borra filas.
-- El orden de despliegue no es estricto: las tres tarjetas y el índice único
-- de tarjetas ya están en vivo (ver paso 4), así que correr esto antes o
-- después de la función no cambia el registro de esas tarjetas.
--
-- Las filas que YA están en la bandeja (pending_review) no se convierten en
-- movimientos aquí: esas siguen entrando solo cuando se aprueban.
--
-- Los pares manual + automático (por ejemplo los del 28 y 29 de sep) NO se
-- tocan aquí. El manual no tiene source_message_id; el automático sí. Esos
-- los limpia Alejo en la app, en "Posibles duplicados".

-- 0. Antes de crear el índice, mira si ya hay correos repetidos. Esta
--    consulta solo lee. No borra nada:
--
--    select source_message_id, count(*) as veces
--    from finance_transactions
--    where source_message_id is not null
--    group by source_message_id
--    having count(*) > 1
--    order by veces desc;
--
--    Si devuelve filas, el paso 1 deja el índice sin crear y avisa. Las
--    funciones del paso 2 y 3 sí quedan, y si un correo ya tiene movimiento
--    no insertan otro (se quedan con el más antiguo). Los repetidos siguen
--    ahí hasta que se revisen a mano.

-- 1. Un correo del banco no debe originar dos movimientos nuevos. Si ya hay
--    source_message_id repetidos, no se crea el índice y no se borra nada.
do $idx$
declare
  v_groups int;
begin
  select count(*) into v_groups from (
    select source_message_id
    from finance_transactions
    where source_message_id is not null
    group by source_message_id
    having count(*) > 1
  ) d;

  if v_groups > 0 then
    raise notice 'Hay % source_message_id repetidos. No se creó el índice único y no se borró ningún dato. Corre la consulta del comentario de esta migración para verlos.', v_groups;
  else
    execute 'create unique index if not exists finance_transactions_source_message_id_uidx on finance_transactions (source_message_id) where source_message_id is not null';
    raise notice 'Índice único parcial listo (o ya existía).';
  end if;
end
$idx$;

-- 2. Aprueba UNA fila de la bandeja: inserta el movimiento y marca la fila
--    como applied en la misma transacción. La fecha, la hora y el texto del
--    correo salen de la fila de la bandeja, no del reloj de quien aprueba.
--    p_tx trae lo editable: profile_id, type, amount, category_id,
--    subcategory_id, goal_id, description, reimbursable, reimburse_by.
--    spend_type sale del kind de la categoría (fixed / variable / income).
--    Si ya existe un movimiento con ese source_message_id no se inserta otro:
--    se enlaza la fila al más antiguo. Si hay varios, no se borra ninguno.
--    Devuelve el id del movimiento.
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

  select id into v_tx_id
  from finance_transactions
  where source_message_id = v_inbox.gmail_message_id
  order by created_at
  limit 1;

  if v_tx_id is null then
    select kind into v_kind from finance_categories where id = v_cat;
    v_spend := case
      when v_type = 'income' then 'income'
      when v_type in ('saving', 'withdrawal') then 'saving'
      when v_kind = 'fixed' then 'fixed'
      else 'variable' end;

    begin
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
    exception
      when unique_violation then
        select id into v_tx_id
        from finance_transactions
        where source_message_id = v_inbox.gmail_message_id
        order by created_at
        limit 1;
        if v_tx_id is null then raise; end if;
    end;
  end if;

  update finance_email_inbox
    set status = 'applied', transaction_id = v_tx_id, profile_id = coalesce(p_tx->>'profile_id', profile_id)
    where id = p_inbox_id;
  return v_tx_id;
end;
$$;

-- 3. Aprueba en lote las filas pendientes que ya traen perfil, monto,
--    categoría y tipo (ingreso o gasto): la misma lista que inboxMissing.
--    O quedan todas o ninguna. Lo incompleto se devuelve en skipped.
--    El bloqueo de tarjeta usa los mismos patrones que el JS y solo los
--    mira en la ventana del monto (40 caracteres antes, 260 después), no
--    en el pie del correo. Un ingreso de la 1887 tampoco entra en el lote.
create or replace function finance_inbox_apply_batch(p_inbox_ids uuid[])
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r finance_email_inbox%rowtype;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_text text;
  v_at int;
  v_from int;
  v_window text;
begin
  for r in select * from finance_email_inbox where id = any(p_inbox_ids) order by received_at for update loop
    v_text := btrim(regexp_replace(coalesce(r.raw_text, ''), '[[:space:]]+', ' ', 'g'));
    v_at := regexp_instr(v_text, '(?:\$|COP)\s*([0-9][0-9.,]*[0-9]|[0-9])');
    if v_at > 0 then
      v_from := greatest(v_at - 40, 1);
      v_window := substr(v_text, v_from, (v_at + 260) - v_from);
    else
      v_window := '';
    end if;
    if r.status <> 'pending_review' or r.profile_id is null or r.parsed is null
       or coalesce((r.parsed->>'amount')::numeric, 0) <= 0
       or nullif(r.parsed->>'category_id', '') is null
       or coalesce(r.parsed->>'type', '') not in ('income', 'expense')
       or (coalesce(r.parsed->>'last4', '') = '1887' and coalesce(r.parsed->>'type', '') = 'income')
       or r.parsed->>'ignored_reason' = 'pago_tarjeta_propia'
       or v_window ~* 'para abonar a la deuda'
       or v_window ~* 'abono a (?:tu |la )?tarjeta de cr[eé]dito'
       or v_window ~* 'a (?:tu |la )?tarjeta de cr[eé]dito'
       or v_window ~* 'pago (?:a |de )(?:tu |la )?tarjeta de cr[eé]dito'
       or v_window ~* '\*1887.{0,180}\*8213|\*8213.{0,180}\*1887' then
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

-- 4. Las tres tarjetas de Alejo ya están registradas en vivo desde el
--    21 de octubre de 2026, en el perfil alejo: 5076 Tarjeta débito compras,
--    8213 Cuenta ahorros y 1887 T. crédito Mastercard. El índice único
--    finance_card_profiles_profile_last4_uidx también ya existe. Este paso
--    no hace nada en esa base: el índice es IF NOT EXISTS y el insert solo
--    agrega un par perfil + últimos 4 que todavía no esté. No borra ni pisa
--    una etiqueta. No hace falta correrlo antes que la función.
do $cards$
declare
  v_dupes int;
begin
  select count(*) into v_dupes from (
    select profile_id, last4
    from finance_card_profiles
    group by profile_id, last4
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise notice 'Hay % pares perfil+últimos 4 repetidos. No se creó el índice único de tarjetas y no se borró nada. El insert de abajo igual no agrega un par que ya exista.', v_dupes;
  else
    execute 'create unique index if not exists finance_card_profiles_profile_last4_uidx on finance_card_profiles (profile_id, last4)';
    raise notice 'Índice único de tarjetas listo (o ya existía).';
  end if;
end
$cards$;

insert into finance_card_profiles (profile_id, last4, label, active)
select v.profile_id, v.last4, v.label, true
from (values
  ('alejo', '5076', 'Tarjeta débito compras'),
  ('alejo', '8213', 'Cuenta ahorros'),
  ('alejo', '1887', 'T. crédito Mastercard')
) as v(profile_id, last4, label)
where not exists (
  select 1 from finance_card_profiles c
  where c.profile_id = v.profile_id and c.last4 = v.last4
);
