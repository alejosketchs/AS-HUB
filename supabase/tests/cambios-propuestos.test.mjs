// Pruebas de apply_change_request / reject_change_request sobre un Postgres
// en memoria (PGlite). No toca Supabase.
//
// Ejecutar (una vez instala PGlite sin tocar el repo):
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node --test supabase/tests/cambios-propuestos.test.mjs
//
// Corre la migración real (supabase/migrations/20261102120000_cambios_propuestos_money.sql)
// sobre un esquema mínimo que imita el de "Suite Personal".
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const pgliteModule = process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : '@electric-sql/pglite';
const { PGlite } = await import(pgliteModule);

const MIGRATION = new URL('../migrations/20261102120000_cambios_propuestos_money.sql', import.meta.url);

const OWNER = '11111111-1111-1111-1111-111111111111';
const STRANGER = '22222222-2222-2222-2222-222222222222';

// Ids fijos para leer las pruebas con calma.
const CAT_VARIOS = 'c0000000-0000-0000-0000-000000000001';
const CAT_OCIO = 'c0000000-0000-0000-0000-000000000002';
const CAT_ALIM = 'c0000000-0000-0000-0000-000000000003';
const CAT_VIVIENDA = 'c0000000-0000-0000-0000-000000000004';
const SUB_SIN = '50000000-0000-0000-0000-000000000001';
const SUB_MECATO = '50000000-0000-0000-0000-000000000002';
const SUB_COMIDAS = '50000000-0000-0000-0000-000000000003';
const SUB_ARRIENDO = '50000000-0000-0000-0000-000000000004';

// Lo mínimo de Supabase que la migración necesita: roles, auth.uid() y private.is_owner().
const STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema private;
grant usage on schema private to authenticated;
create table private.owners (user_id uuid primary key);
insert into private.owners values ('${OWNER}');
create function private.is_owner() returns boolean language sql stable security definer set search_path = '' as
  $$ select exists (select 1 from private.owners o where o.user_id = (select auth.uid())) $$;
revoke all on function private.is_owner() from public;
grant execute on function private.is_owner() to authenticated;

grant usage on schema public to anon, authenticated, service_role;

create table public.profiles (id text primary key, name text not null);
create table public.finance_categories (
  id uuid primary key, profile_id text, name text not null,
  kind text not null check (kind in ('fixed', 'variable', 'income'))
);
create table public.finance_subcategories (
  id uuid primary key, category_id uuid not null references public.finance_categories (id), name text not null
);
create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles (id),
  type text not null check (type in ('income', 'expense', 'saving', 'withdrawal')),
  amount numeric not null check (amount > 0),
  transaction_date date not null,
  category_id uuid references public.finance_categories (id),
  subcategory_id uuid references public.finance_subcategories (id),
  spend_type text,
  description text default ''
);
create table public.budgets (
  id uuid primary key default gen_random_uuid(), profile_id text not null, kind text not null,
  name text not null, amount numeric not null default 0, active boolean not null default true,
  period text not null default 'month', category_id uuid not null, subcategory_id uuid
);
create table public.finance_merchant_rules (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles (id),
  merchant_key text not null,
  category_id uuid, subcategory_id uuid, note text
);
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;

insert into public.profiles values ('alejo', 'Shori'), ('toli', 'Toli');
insert into public.finance_categories values
  ('${CAT_VARIOS}', 'alejo', 'Varios / Ocasionales', 'variable'),
  ('${CAT_OCIO}', 'alejo', 'Ocio', 'variable'),
  ('${CAT_ALIM}', 'alejo', 'Alimentación', 'variable'),
  ('${CAT_VIVIENDA}', 'alejo', 'Vivienda', 'fixed');
insert into public.finance_subcategories values
  ('${SUB_SIN}', '${CAT_VARIOS}', 'Sin clasificar'),
  ('${SUB_MECATO}', '${CAT_OCIO}', 'Mecato / cafés / antojos'),
  ('${SUB_COMIDAS}', '${CAT_ALIM}', 'Comidas por fuera'),
  ('${SUB_ARRIENDO}', '${CAT_VIVIENDA}', 'Arriendo');
`;

let db;

before(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(await readFile(MIGRATION, 'utf8'));
});

/** Corre fn como el rol dado (y con auth.uid() = uid), dentro de una transacción. */
async function as(role, uid, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

async function newTx(over = {}) {
  const t = {
    type: 'expense', amount: 20000, transaction_date: '2026-11-01',
    category_id: CAT_VARIOS, subcategory_id: SUB_SIN, spend_type: 'variable',
    description: 'Transferencia a *5723', ...over,
  };
  return one(
    `insert into public.finance_transactions
       (profile_id, type, amount, transaction_date, category_id, subcategory_id, spend_type, description)
     values ('alejo', $1, $2, $3, $4, $5, $6, $7) returning *`,
    [t.type, t.amount, t.transaction_date, t.category_id, t.subcategory_id, t.spend_type, t.description],
  );
}

/** Lo que haría Money Admin: leer el movimiento y proponer, con el rol de servicio. */
async function propose(txId, changeType, oldValue, newValue, extra = {}) {
  return as('service_role', null, async (tx) => (await tx.query(
    `insert into public.finance_change_requests
       (profile_id, transaction_id, change_type, old_value, new_value, reason, save_merchant_rule)
     values ('alejo', $1, $2, $3, $4, $5, $6) returning *`,
    [txId, changeType, JSON.stringify(oldValue), JSON.stringify(newValue), extra.reason || 'prueba', !!extra.save],
  )).rows[0]);
}

const apply = (id, saveRule = null) => as('authenticated', OWNER, async (tx) =>
  (await tx.query('select public.apply_change_request($1, $2) as s', [id, saveRule])).rows[0].s);
const reject = (id) => as('authenticated', OWNER, async (tx) =>
  (await tx.query('select public.reject_change_request($1) as s', [id])).rows[0].s);
const txRow = (id) => one('select * from public.finance_transactions where id = $1', [id]);
const reqRow = (id) => one('select * from public.finance_change_requests where id = $1', [id]);

test('aplica un cambio de categoría (Transferencia 20.000 *5723 → Ocio › Mecato)', async () => {
  const t = await newTx();
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_OCIO, subcategory_id: SUB_MECATO });

  assert.equal(await apply(r.id), 'applied');
  const after = await txRow(t.id);
  assert.equal(after.category_id, CAT_OCIO);
  assert.equal(after.subcategory_id, SUB_MECATO);
  assert.equal(after.spend_type, 'variable');
  const req = await reqRow(r.id);
  assert.equal(req.status, 'applied');
  assert.ok(req.decided_at);
  // Sin "Recordar", no se crea regla.
  assert.equal((await one(`select count(*)::int as n from public.finance_merchant_rules`)).n, 0);
});

test('aplicar dos veces no repite el cambio', async () => {
  const t = await newTx({ amount: 5000 });
  const r = await propose(t.id, 'amount', { amount: 5000 }, { amount: 5500 });
  assert.equal(await apply(r.id), 'applied');
  assert.equal(await apply(r.id), 'applied');
  assert.equal(Number((await txRow(t.id)).amount), 5500);
});

test('categoría fija deja el gasto como fijo', async () => {
  const t = await newTx({ description: 'ARRIENDO NOV' });
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_VIVIENDA, subcategory_id: SUB_ARRIENDO });
  assert.equal(await apply(r.id), 'applied');
  assert.equal((await txRow(t.id)).spend_type, 'fixed');
});

test('detecta conflicto si el movimiento cambió y no toca nada', async () => {
  const t = await newTx({ description: 'Pago PSE' });
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_OCIO, subcategory_id: SUB_MECATO });
  // La persona lo recategoriza a mano antes de aprobar.
  await db.query('update public.finance_transactions set category_id = $1, subcategory_id = $2 where id = $3',
    [CAT_ALIM, SUB_COMIDAS, t.id]);

  assert.equal(await apply(r.id), 'conflict');
  const after = await txRow(t.id);
  assert.equal(after.category_id, CAT_ALIM);
  assert.equal(after.subcategory_id, SUB_COMIDAS);
  assert.equal((await reqRow(r.id)).status, 'conflict');
});

test('conflicto en monto y descripción', async () => {
  const t = await newTx({ amount: 9000, description: 'Original' });
  const a = await propose(t.id, 'amount', { amount: 8000 }, { amount: 7000 });
  const d = await propose(t.id, 'description', { description: 'Otra' }, { description: 'Nueva' });
  assert.equal(await apply(a.id), 'conflict');
  assert.equal(await apply(d.id), 'conflict');
  const after = await txRow(t.id);
  assert.equal(Number(after.amount), 9000);
  assert.equal(after.description, 'Original');
});

test('rechaza sin tocar el movimiento', async () => {
  const t = await newTx({ description: 'Nequi' });
  const r = await propose(t.id, 'description', { description: 'Nequi' }, { description: 'Nequi a mamá' });
  assert.equal(await reject(r.id), 'rejected');
  assert.equal((await txRow(t.id)).description, 'Nequi');
  const req = await reqRow(r.id);
  assert.equal(req.status, 'rejected');
  assert.ok(req.decided_at);
  // Ya rechazada: aplicarla no hace nada.
  assert.equal(await apply(r.id), 'rejected');
  assert.equal((await txRow(t.id)).description, 'Nequi');
});

test('crea la regla de comercio (GOCETO SAS → Alimentación › Comidas por fuera)', async () => {
  const t = await newTx({ amount: 38200, description: '  goceto   sas ' });
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_ALIM, subcategory_id: SUB_COMIDAS });

  // La persona marca "Recordar para este comercio" en la app.
  assert.equal(await apply(r.id, true), 'applied');
  const rule = await one(`select * from public.finance_merchant_rules where merchant_key = 'GOCETO SAS'`);
  assert.ok(rule, 'debe existir la regla con la misma clave que usa la ingesta');
  assert.equal(rule.profile_id, 'alejo');
  assert.equal(rule.category_id, CAT_ALIM);
  assert.equal(rule.subcategory_id, SUB_COMIDAS);
  assert.equal((await reqRow(r.id)).save_merchant_rule, true);

  // Una segunda propuesta para el mismo comercio actualiza la regla, no la duplica.
  const t2 = await newTx({ amount: 12000, description: 'GOCETO SAS' });
  const r2 = await propose(t2.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_OCIO, subcategory_id: SUB_MECATO }, { save: true });
  assert.equal(await apply(r2.id), 'applied');
  const rules = (await db.query(`select * from public.finance_merchant_rules where merchant_key = 'GOCETO SAS'`)).rows;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].subcategory_id, SUB_MECATO);
});

test('desmarcar "Recordar" en la app gana sobre lo que propuso el bot', async () => {
  const t = await newTx({ description: 'TIENDA D1' });
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_ALIM, subcategory_id: SUB_COMIDAS }, { save: true });
  assert.equal(await apply(r.id, false), 'applied');
  assert.equal(await one(`select * from public.finance_merchant_rules where merchant_key = 'TIENDA D1'`), undefined);
});

test('ignora un movimiento (Transferencia 250.000 *3583)', async () => {
  const t = await newTx({ amount: 250000, transaction_date: '2026-10-25', description: 'Transferencia a *3583' });
  assert.equal(t.ignored, false);
  const r = await propose(t.id, 'ignore', { ignored: false }, { ignored: true });
  assert.equal(await apply(r.id), 'applied');
  assert.equal((await txRow(t.id)).ignored, true);
});

test('rechaza solicitudes mal armadas al insertar', async () => {
  const t = await newTx();
  await assert.rejects(propose(t.id, 'amount', { amount: 20000 }, { amount: -5 }));
  await assert.rejects(propose(t.id, 'ignore', { ignored: false }, { ignored: 'si' }));
  await assert.rejects(propose(t.id, 'description', { description: 'x' }, { description: 'y' }, { save: true }));
  // Una sola pendiente por movimiento y tipo.
  await propose(t.id, 'description', { description: t.description }, { description: 'A' });
  await assert.rejects(propose(t.id, 'description', { description: t.description }, { description: 'B' }));
});

test('categoría que no existe: error y la solicitud sigue pendiente', async () => {
  const t = await newTx({ description: 'X' });
  const r = await propose(t.id, 'category',
    { category_id: CAT_VARIOS, subcategory_id: SUB_SIN },
    { category_id: CAT_OCIO, subcategory_id: SUB_COMIDAS }); // sub de otra categoría
  await assert.rejects(apply(r.id), /no pertenece/);
  assert.equal((await reqRow(r.id)).status, 'pending');
  assert.equal((await txRow(t.id)).category_id, CAT_VARIOS);
});

test('permisos: anon no ve nada, solo el dueño aplica, nadie con sesión inserta', async () => {
  const t = await newTx({ description: 'Permisos' });
  const r = await propose(t.id, 'description', { description: 'Permisos' }, { description: 'P2' });

  await assert.rejects(as('anon', null, (tx) => tx.query('select * from public.finance_change_requests')));
  await assert.rejects(as('anon', null, (tx) => tx.query('select public.apply_change_request($1)', [r.id])));

  // Autenticado pero no dueño: no ve filas y la función lo rechaza.
  const seen = await as('authenticated', STRANGER, async (tx) =>
    (await tx.query('select count(*)::int as n from public.finance_change_requests')).rows[0].n);
  assert.equal(seen, 0);
  await assert.rejects(as('authenticated', STRANGER, (tx) => tx.query('select public.apply_change_request($1)', [r.id])), /Sin permiso/);
  await assert.rejects(as('authenticated', STRANGER, (tx) => tx.query('select public.reject_change_request($1)', [r.id])), /Sin permiso/);

  // El dueño ve, puede cambiar el estado, pero no insertar ni tocar otras columnas.
  const ownerSees = await as('authenticated', OWNER, async (tx) =>
    (await tx.query('select count(*)::int as n from public.finance_change_requests where id = $1', [r.id])).rows[0].n);
  assert.equal(ownerSees, 1);
  await assert.rejects(as('authenticated', OWNER, (tx) => tx.query(
    `insert into public.finance_change_requests (transaction_id, change_type, old_value, new_value)
     values ($1, 'ignore', '{"ignored":false}', '{"ignored":true}')`, [t.id])));
  await assert.rejects(as('authenticated', OWNER, (tx) => tx.query(
    `update public.finance_change_requests set new_value = '{"description":"hack"}' where id = $1`, [r.id])));
  await as('authenticated', OWNER, (tx) => tx.query(
    `update public.finance_change_requests set status = 'rejected', decided_at = now() where id = $1`, [r.id]));
  assert.equal((await reqRow(r.id)).status, 'rejected');
});

test('borrar el movimiento borra sus solicitudes', async () => {
  const t = await newTx({ description: 'Borrar' });
  const r = await propose(t.id, 'description', { description: 'Borrar' }, { description: 'B' });
  await db.query('delete from public.finance_transactions where id = $1', [t.id]);
  assert.equal(await reqRow(r.id), undefined);
});
