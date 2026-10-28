#!/usr/bin/env node
// Comprueba contra Supabase que:
//   1. SIN sesión (solo la llave pública) no se puede leer, borrar ni llamar
//      las funciones de NINGUNA tabla.
//   2. CON la sesión del dueño sí se puede leer todo y escribir.
//
// Uso:
//   node scripts/check-rls.mjs                 -> solo la parte "sin sesión"
//   AS_EMAIL=... AS_PASSWORD=... node scripts/check-rls.mjs
//                                              -> también la parte "con sesión"
//   Pon AS_EMAIL / AS_PASSWORD solo en tu terminal; nunca en un archivo.
//
// No muestra datos: solo códigos de respuesta. No cambia datos reales: la
// prueba "sin sesión" borra con un filtro imposible (x es null Y x no es null)
// y la prueba "con sesión" crea y borra una fila de prueba en suite_data.

import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';

// tabla -> una columna que exista (para el filtro imposible)
const TABLES = {
  profiles: 'id', sessions: 'token', suite_data: 'id', user_suite_data: 'user_id',
  tasks: 'id', task_projects: 'id', agenda_events: 'id', notes: 'id',
  finance_categories: 'id', finance_subcategories: 'id', finance_transactions: 'id',
  budgets: 'id', budget_checks: 'id', debts: 'id', savings_goals: 'id',
  finance_card_profiles: 'id', finance_email_inbox: 'id', finance_merchant_rules: 'id',
  finance_profile_data: 'profile_id',
  reader_users: 'id', reader_books: 'id', reader_logs: 'id', reader_unlocks: 'id',
  reader_glossary: 'id', reader_quotes: 'id', reader_push_subs: 'id', reader_push_sent: 'id',
};

// Tablas que el dueño no lee directo a propósito (solo el servidor).
const OWNER_SKIP = new Set(['finance_profile_data', 'user_suite_data']);

const RPCS = {
  finance_inbox_apply_batch: { p_inbox_ids: [] },
  finance_inbox_apply: { p_inbox_id: '00000000-0000-0000-0000-000000000000', p_tx: {} },
  finance_email_inbox_on_tx_delete: {},
};

const REST = `${SUPABASE_URL}/rest/v1`;
const headers = (token) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${token || SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

/** Denegado = la base respondió "sin permiso" (401/403), no un 200 vacío. */
const isDenied = (status) => status === 401 || status === 403;

let fallos = 0;
const ok = (msg) => console.log(`  OK    ${msg}`);
const mal = (msg) => { fallos++; console.log(`  FALLA ${msg}`); };

async function sinSesion() {
  console.log('\n1) SIN sesión (llave pública sola): todo debe estar DENEGADO');
  for (const [t, col] of Object.entries(TABLES)) {
    const r = await fetch(`${REST}/${t}?select=*&limit=1`, { headers: headers() });
    isDenied(r.status) ? ok(`leer ${t} -> ${r.status}`) : mal(`leer ${t} -> ${r.status} (se pudo leer)`);

    const d = await fetch(`${REST}/${t}?${col}=is.null&${col}=not.is.null`, {
      method: 'DELETE', headers: { ...headers(), Prefer: 'return=minimal' },
    });
    isDenied(d.status) ? ok(`borrar ${t} -> ${d.status}`) : mal(`borrar ${t} -> ${d.status} (tiene permiso de borrar)`);
  }
  for (const [fn, args] of Object.entries(RPCS)) {
    const r = await fetch(`${REST}/rpc/${fn}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) });
    isDenied(r.status) || r.status === 404 ? ok(`llamar ${fn} -> ${r.status}`) : mal(`llamar ${fn} -> ${r.status} (se pudo llamar)`);
  }
}

async function conSesion(email, password) {
  console.log('\n2) CON tu sesión: todo debe FUNCIONAR');
  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ email, password }),
  });
  if (!auth.ok) { mal(`iniciar sesión -> ${auth.status}`); return; }
  const { access_token: token } = await auth.json();
  ok('iniciar sesión');

  for (const t of Object.keys(TABLES)) {
    if (OWNER_SKIP.has(t)) continue;
    const r = await fetch(`${REST}/${t}?select=*&limit=1`, { headers: headers(token) });
    r.ok ? ok(`leer ${t} -> ${r.status}`) : mal(`leer ${t} -> ${r.status}`);
  }
  const p = await fetch(`${REST}/profiles?select=id`, { headers: headers(token) });
  const perfiles = p.ok ? await p.json() : [];
  perfiles.length > 0 ? ok(`ves tus perfiles (${perfiles.length})`) : mal('no se ven los perfiles');

  const id = '__rls_check__';
  const ins = await fetch(`${REST}/suite_data`, {
    method: 'POST', headers: { ...headers(token), Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify({ id, payload: { prueba: true } }),
  });
  ins.ok ? ok(`escribir suite_data -> ${ins.status}`) : mal(`escribir suite_data -> ${ins.status}`);
  const del = await fetch(`${REST}/suite_data?id=eq.${id}`, { method: 'DELETE', headers: headers(token) });
  del.ok ? ok(`borrar fila de prueba -> ${del.status}`) : mal(`borrar fila de prueba -> ${del.status}`);

  const rpc = await fetch(`${REST}/rpc/finance_inbox_apply_batch`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ p_inbox_ids: [] }),
  });
  rpc.ok ? ok(`llamar finance_inbox_apply_batch -> ${rpc.status}`) : mal(`llamar finance_inbox_apply_batch -> ${rpc.status}`);
}

await sinSesion();
const { AS_EMAIL, AS_PASSWORD } = process.env;
if (AS_EMAIL && AS_PASSWORD) await conSesion(AS_EMAIL, AS_PASSWORD);
else console.log('\n2) CON sesión: omitido (define AS_EMAIL y AS_PASSWORD en tu terminal para probarlo)');
console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo bien.');
process.exit(fallos ? 1 : 0);
