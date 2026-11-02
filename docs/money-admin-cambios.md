# Money Admin: cómo proponer cambios a movimientos

Money Admin (el bot, con el conector de Supabase y rol de servicio) **no edita
`finance_transactions`**. Propone el cambio en `finance_change_requests` y la
persona lo aprueba o rechaza en AS HUB → Finanzas → **📝 Cambios propuestos**.

Tabla y funciones: `supabase/migrations/20261102120000_cambios_propuestos_money.sql`.

## Reglas

1. **Lee el movimiento justo antes** y guarda en `old_value` lo que viste. Al
   aprobar, `apply_change_request` compara `old_value` con el movimiento actual;
   si alguien lo cambió entretanto, la solicitud queda en `conflict` y no se toca
   nada. Lo más seguro es armar `old_value` en el mismo `INSERT ... SELECT`
   (ejemplos abajo): así se lee en el mismo instante.
2. Llena `profile_id` con el del movimiento y escribe un `reason` corto y claro
   en español (se le muestra a la persona).
3. Una sola solicitud **pendiente** por movimiento y tipo de cambio. Si ya hay
   una, el `INSERT` falla (índice `finance_change_requests_one_pending`).
4. Usa ids reales de `finance_categories` / `finance_subcategories`: búscalos
   por nombre, nunca los inventes. Si no hay categoría clara, no propongas nada
   (o deja 🎁 Varios / Ocasionales → ❓ Sin clasificar).
5. `save_merchant_rule = true` solo en cambios de **categoría**, cuando el
   comercio siempre debería ir ahí (la persona puede desmarcarlo al aprobar).
   La regla usa como clave la descripción del movimiento normalizada igual que
   la ingesta: sin espacios a los lados, en MAYÚSCULAS y con los espacios
   repetidos colapsados (`'  goceto   sas '` → `'GOCETO SAS'`).
6. No borres ni cambies solicitudes ya decididas (`applied`, `rejected`,
   `conflict`). Si una quedó en `conflict`, vuelve a leer y crea una nueva.

## Forma de `old_value` / `new_value`

| `change_type` | `old_value` (lo que viste)                   | `new_value` (lo que propones)                |
|---------------|-----------------------------------------------|-----------------------------------------------|
| `category`    | `{"category_id": "…", "subcategory_id": "…"}` | `{"category_id": "…", "subcategory_id": "…"}` |
| `ignore`      | `{"ignored": false}`                          | `{"ignored": true}`                           |
| `amount`      | `{"amount": 20000}`                           | `{"amount": 25000}`                           |
| `description` | `{"description": "texto actual"}`             | `{"description": "texto nuevo"}`             |

`subcategory_id` puede ser `null`. El monto va como número (sin puntos ni `$`).
Un `INSERT` con `new_value` mal formado falla de una vez (restricción
`finance_change_requests_new_value_shape`).

## 1. Encontrar el movimiento

```sql
select id, profile_id, transaction_date, type, amount, description,
       category_id, subcategory_id, ignored
from public.finance_transactions
where profile_id = 'alejo'
  and transaction_date = '2026-11-01'
  and amount = 20000
  and description ilike '%5723%';
```

Ids de categoría y subcategoría por nombre:

```sql
select c.id as category_id, c.name as categoria, s.id as subcategory_id, s.name as subcategoria
from public.finance_categories c
left join public.finance_subcategories s on s.category_id = c.id
where c.name ilike 'Ocio%' and s.name ilike 'Mecato%';
```

## 2. Proponer (un ejemplo por tipo)

Cambia `:tx_id` por el `id` del movimiento. Cada `INSERT` lee el movimiento en
ese mismo momento para armar `old_value`.

### Categoría

Transferencia de 20.000 a \*5723 del 1 nov → Ocio › Mecato / cafés / antojos:

```sql
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason, save_merchant_rule)
select t.profile_id, t.id, 'category',
       jsonb_build_object('category_id', t.category_id, 'subcategory_id', t.subcategory_id),
       jsonb_build_object('category_id', s.category_id, 'subcategory_id', s.id),
       'Transferencia pequeña a *5723: es para mecato / café.',
       false
from public.finance_transactions t
cross join (
  select s.id, s.category_id
  from public.finance_subcategories s
  join public.finance_categories c on c.id = s.category_id
  where c.name = 'Ocio' and s.name = 'Mecato / cafés / antojos'
) s
where t.id = ':tx_id'
returning id, status;
```

Con regla de comercio (GOCETO SAS 38.200 → Alimentación › Comidas por fuera):
igual que arriba, pero con la subcategoría `Comidas por fuera` de
`Alimentación` y `save_merchant_rule = true`. Al aprobar con "Recordar para
este comercio" marcado, los próximos GOCETO SAS entran solos en esa categoría.

Si la consulta no devuelve fila (`returning` vacío), el nombre de la categoría o
subcategoría no coincidió: revisa con la consulta del paso 1.

### Ignorar

Transferencia de 250.000 a \*3583 del 25 oct (p. ej. entre cuentas propias):

```sql
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason)
select t.profile_id, t.id, 'ignore',
       jsonb_build_object('ignored', t.ignored),
       '{"ignored": true}'::jsonb,
       'Transferencia a mi otra cuenta (*3583): no es gasto.'
from public.finance_transactions t
where t.id = ':tx_id'
returning id, status;
```

Un movimiento ignorado sigue en la lista (atenuado, con la etiqueta
"Ignorado") pero no cuenta en totales, gráficas, presupuestos ni saldo. La
persona lo puede volver a contar a mano con ↺.

### Monto

```sql
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason)
select t.profile_id, t.id, 'amount',
       jsonb_build_object('amount', t.amount),
       '{"amount": 25000}'::jsonb,
       'El extracto dice 25.000, la alerta llegó con 20.000.'
from public.finance_transactions t
where t.id = ':tx_id'
returning id, status;
```

### Descripción

```sql
insert into public.finance_change_requests
  (profile_id, transaction_id, change_type, old_value, new_value, reason)
select t.profile_id, t.id, 'description',
       jsonb_build_object('description', t.description),
       '{"description": "Almuerzo con Toli"}'::jsonb,
       'Nombre más claro que el del banco.'
from public.finance_transactions t
where t.id = ':tx_id'
returning id, status;
```

## 3. Revisar qué pasó

```sql
select id, change_type, status, reason, created_at, decided_at
from public.finance_change_requests
order by created_at desc
limit 20;
```

- `pending`: esperando a la persona.
- `applied`: aprobado y aplicado.
- `rejected`: la persona dijo que no. No lo vuelvas a proponer igual.
- `conflict`: el movimiento cambió antes de aprobar. Vuelve a leerlo y, si
  sigue haciendo falta, crea una solicitud nueva.
