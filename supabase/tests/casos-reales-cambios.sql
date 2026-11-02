-- =====================================================================
-- Prueba manual con 3 movimientos reales (SQL Editor de Supabase).
-- Correr DESPUÉS de 20261102120000_cambios_propuestos_money.sql.
-- Hace lo mismo que haría Money Admin: crea 3 solicitudes PENDIENTES.
-- No cambia ningún movimiento: eso pasa solo cuando apruebas en la app.
--
-- Paso 0 (opcional): mira que cada movimiento aparezca UNA sola vez.
-- Si alguno no sale o sale repetido, ajusta el filtro (fecha, monto o texto).
-- =====================================================================
select id, transaction_date, amount, description
from public.finance_transactions
where (transaction_date = '2026-11-01' and amount = 20000 and description ilike '%5723%')
   or (amount = 38200 and description ilike '%goceto%')
   or (transaction_date = '2026-10-25' and amount = 250000 and description ilike '%3583%')
order by transaction_date;

-- Mira también los nombres exactos de las categorías destino:
select c.name as categoria, s.name as subcategoria
from public.finance_subcategories s
join public.finance_categories c on c.id = s.category_id
where (c.name ilike 'ocio%' and s.name ilike 'mecato%')
   or (c.name ilike 'aliment%' and s.name ilike 'comidas por fuera%');

-- 1) Transferencia de 20.000 a *5723 del 1 nov → Ocio › Mecato / cafés / antojos
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason, save_merchant_rule)
select t.profile_id, t.id, 'category',
       jsonb_build_object('category_id', t.category_id, 'subcategory_id', t.subcategory_id),
       jsonb_build_object('category_id', s.category_id, 'subcategory_id', s.id),
       'Prueba: transferencia pequeña a *5723, es mecato / café.', false
from public.finance_transactions t
cross join (
  select s.id, s.category_id from public.finance_subcategories s
  join public.finance_categories c on c.id = s.category_id
  where c.name ilike 'ocio%' and s.name ilike 'mecato%' limit 1
) s
where t.transaction_date = '2026-11-01' and t.amount = 20000 and t.description ilike '%5723%'
returning id, change_type, status;

-- 2) GOCETO SAS 38.200 → Alimentación › Comidas por fuera (propone "Recordar para este comercio")
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason, save_merchant_rule)
select t.profile_id, t.id, 'category',
       jsonb_build_object('category_id', t.category_id, 'subcategory_id', t.subcategory_id),
       jsonb_build_object('category_id', s.category_id, 'subcategory_id', s.id),
       'Prueba: GOCETO SAS es restaurante.', true
from public.finance_transactions t
cross join (
  select s.id, s.category_id from public.finance_subcategories s
  join public.finance_categories c on c.id = s.category_id
  where c.name ilike 'aliment%' and s.name ilike 'comidas por fuera%' limit 1
) s
where t.amount = 38200 and t.description ilike '%goceto%'
returning id, change_type, status;

-- 3) Transferencia de 250.000 a *3583 del 25 oct → ignorada
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason)
select t.profile_id, t.id, 'ignore',
       jsonb_build_object('ignored', t.ignored),
       '{"ignored": true}'::jsonb,
       'Prueba: transferencia a *3583, entre cuentas propias.'
from public.finance_transactions t
where t.transaction_date = '2026-10-25' and t.amount = 250000 and t.description ilike '%3583%'
returning id, change_type, status;

-- Después de aprobar en la app, revisa:
select r.change_type, r.status, r.decided_at, t.description, t.amount, t.ignored,
       c.name as categoria, s.name as subcategoria
from public.finance_change_requests r
join public.finance_transactions t on t.id = r.transaction_id
left join public.finance_categories c on c.id = t.category_id
left join public.finance_subcategories s on s.id = t.subcategory_id
order by r.created_at desc limit 10;

select merchant_key, category_id, subcategory_id
from public.finance_merchant_rules where merchant_key ilike '%GOCETO%';
