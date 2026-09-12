-- AS FINANZAS · migración "copiloto financiero" (septiembre 2026)
-- Compatible con el historial existente: no se borra ningún movimiento, meta ni deuda.
-- Se aplica en Supabase (proyecto derzetuipyugmrjaxcyu).

begin;

-- 1. Movimientos: nuevos tipos (ahorro / retiro) y gastos reembolsables
alter table finance_transactions
  add column if not exists reimbursable boolean not null default false,
  add column if not exists reimburse_by text not null default '',
  add column if not exists reimbursed_at timestamptz,
  add column if not exists reimbursement_id uuid references finance_transactions(id) on delete set null,
  add column if not exists goal_id uuid references savings_goals(id) on delete set null;

alter table finance_transactions drop constraint if exists finance_transactions_type_check;
alter table finance_transactions add constraint finance_transactions_type_check
  check (type in ('income', 'expense', 'saving', 'withdrawal'));

alter table finance_transactions drop constraint if exists finance_transactions_spend_type_check;
alter table finance_transactions add constraint finance_transactions_spend_type_check
  check (spend_type in ('fixed', 'variable', 'income', 'saving'));

-- 2. Presupuestos: mensuales o semanales, con grupo y subcategoría opcional
alter table budgets
  add column if not exists period text not null default 'month',
  add column if not exists group_key text not null default '',
  add column if not exists subcategory_id uuid references finance_subcategories(id) on delete set null;
alter table budgets drop constraint if exists budgets_period_check;
alter table budgets add constraint budgets_period_check check (period in ('month', 'week'));

-- 3. Perfil: saldo inicial para que el saldo disponible cuadre con la cuenta
alter table profiles add column if not exists opening_balance numeric not null default 0;

-- 4. Categorías: Mecato deja de ser alimentación y pasa a Ocio (gasto discrecional)
update finance_subcategories
   set category_id = (select id from finance_categories where slug = 'fun'),
       name = 'Mecato / cafés / antojos'
 where name = 'Mecato'
   and category_id = (select id from finance_categories where slug = 'food');

-- Los movimientos que ya tenían la subcategoría Mecato siguen a su nueva categoría (solo cambia la categoría, no monto ni fecha).
update finance_transactions
   set category_id = (select id from finance_categories where slug = 'fun')
 where subcategory_id = (select id from finance_subcategories where name = 'Mecato / cafés / antojos');

update finance_subcategories
   set name = 'Maricaditas / objetos o caprichos'
 where name = 'Maricaditas / objetos'
   and category_id = (select id from finance_categories where slug = 'fun');

-- Subcategorías fijas que faltaban (para detectar el pago automáticamente)
insert into finance_subcategories (category_id, name, emoji, sort_order)
select c.id, v.name, v.emoji, v.sort_order
  from finance_categories c
  join (values ('Psicología', '🧠', 20), ('Gym', '🏋️', 21)) as v(name, emoji, sort_order) on true
 where c.slug = 'housing'
   and not exists (select 1 from finance_subcategories s where s.category_id = c.id and s.name = v.name);

-- 5. spend_type corregido: solo lo de "Fijos mensuales" es fijo.
--    (El presupuesto "Comida" marcaba mercado y comidas como fijos.)
update finance_transactions
   set spend_type = 'variable'
 where type = 'expense'
   and spend_type = 'fixed'
   and category_id is distinct from (select id from finance_categories where slug = 'housing');

-- 6. Plan mensual de Shori (alejo): gastos fijos vinculados a su subcategoría
update budgets set name = 'Arriendo' where profile_id = 'alejo' and kind = 'fixed' and name = 'Rent';
update budgets set name = 'CapCut'   where profile_id = 'alejo' and kind = 'fixed' and name = 'Cap Cut';
update budgets set name = 'Internet hogar' where profile_id = 'alejo' and kind = 'fixed' and name = 'Internet Hogar';

update budgets b
   set subcategory_id = s.id,
       category_id = s.category_id
  from finance_subcategories s
  join finance_categories c on c.id = s.category_id and c.slug = 'housing'
 where b.profile_id = 'alejo' and b.kind = 'fixed' and b.period = 'month'
   and (lower(s.name) = lower(b.name)
        or (b.name = 'Internet hogar' and s.name = 'Internet Tigo')
        or (b.name = 'Móvil Éxito' and s.name = 'Datos móvil Éxito'));

insert into budgets (profile_id, kind, name, amount, category_id, subcategory_id, period)
select 'alejo', 'fixed', v.name, v.amount, s.category_id, s.id, 'month'
  from (values ('Paramount+', 23500), ('Spotify', 18500)) as v(name, amount)
  join finance_subcategories s on s.name = v.name
  join finance_categories c on c.id = s.category_id and c.slug = 'housing'
 where not exists (select 1 from budgets where profile_id = 'alejo' and kind = 'fixed' and name = v.name);

-- "Comida" (fijo) y los variables mensuales viejos (Gasolina, Gusticos) se reemplazan por el semanal.
delete from budgets where profile_id = 'alejo' and kind = 'fixed' and name = 'Comida';
delete from budgets where profile_id = 'alejo' and kind = 'variable' and period = 'month';

-- 7. Presupuesto semanal inicial de Shori
insert into budgets (profile_id, kind, name, amount, category_id, subcategory_id, period, group_key, is_weekly, sort_order)
select 'alejo', 'variable', v.name, v.amount,
       (select id from finance_categories where slug = v.cat),
       case when v.sub is null then null else (select id from finance_subcategories s
             where s.name = v.sub and s.category_id = (select id from finance_categories where slug = v.cat)) end,
       'week', v.grp, true, v.ord
  from (values
        ('Mercado',                  115000, 'food',      'Mercado del hogar',        'need', 1),
        ('Gasolina',                  40000, 'transport', 'Gasolina',                 'need', 2),
        ('Transporte personal',       40000, 'transport', null,                       'need', 3),
        ('Comidas por fuera',         45000, 'food',      'Comidas por fuera',        'life', 4),
        ('Ocio / planes sociales',    65000, 'fun',       null,                       'life', 5),
        ('Mecato / cafés / antojos',  25000, 'fun',       'Mecato / cafés / antojos', 'life', 6)
       ) as v(name, amount, cat, sub, grp, ord)
 where not exists (select 1 from budgets where profile_id = 'alejo' and period = 'week' and name = v.name);

-- 8. Milla de Oro histórico: reembolsable por Dead Camera. Los reembolsos recibidos
--    hasta el 11 de septiembre cubren todo lo registrado hasta esa fecha, así que quedan conciliados.
update finance_transactions
   set reimbursable = true, reimburse_by = 'Dead Camera'
 where profile_id = 'alejo' and type = 'expense' and description ilike 'milla de oro';

update finance_transactions
   set reimbursed_at = (transaction_date::text || 'T12:00:00-05:00')::timestamptz
 where reimbursable and reimbursed_at is null and transaction_date <= '2026-09-11';

commit;
