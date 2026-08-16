// AS HUB — capa de datos (Supabase + caché local)
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// Se intenta más de un CDN: si uno falla, la app sigue funcionando.
const CDNS = [
  'https://esm.sh/@supabase/supabase-js@2.45.4',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm',
  'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/module/index.js',
];

async function loadCreateClient() {
  let lastError;
  for (const url of CDNS) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      if (mod?.createClient) return mod.createClient;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('No se pudo cargar la librería de datos');
}

const createClient = await loadCreateClient();

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

/* ---------- caché local: la app abre al instante y sin conexión ---------- */
const CACHE_PREFIX = 'ashub:cache:';

export function readCache(key, fallback = null) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

export function writeCache(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* cuota llena */ }
}

/** Devuelve el caché de inmediato y refresca en segundo plano. */
export async function cached(key, loader, onFresh) {
  const local = readCache(key);
  if (local != null && onFresh) onFresh(local, true);
  try {
    const fresh = await loader();
    writeCache(key, fresh);
    if (onFresh) onFresh(fresh, false);
    return fresh;
  } catch (err) {
    if (local != null) return local;
    throw err;
  }
}

/* ---------- helpers ---------- */
export function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export const online = () => navigator.onLine;

/* ---------- TAREAS ---------- */
export const Tasks = {
  async list() {
    return unwrap(await sb.from('tasks').select('*')
      .order('status', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false }));
  },
  async create(task) {
    return unwrap(await sb.from('tasks').insert(task).select().single());
  },
  async update(id, patch) {
    return unwrap(await sb.from('tasks').update(patch).eq('id', id).select().single());
  },
  async remove(id) {
    return unwrap(await sb.from('tasks').delete().eq('id', id));
  },
};

export const Projects = {
  async list() {
    return unwrap(await sb.from('task_projects').select('*')
      .order('sort_order', { ascending: true }));
  },
  async create(p) { return unwrap(await sb.from('task_projects').insert(p).select().single()); },
  async update(id, patch) { return unwrap(await sb.from('task_projects').update(patch).eq('id', id).select().single()); },
  async remove(id) { return unwrap(await sb.from('task_projects').delete().eq('id', id)); },
};

export const Notes = {
  async list() {
    return unwrap(await sb.from('notes').select('*')
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false }));
  },
  async create(n) { return unwrap(await sb.from('notes').insert(n).select().single()); },
  async update(id, patch) { return unwrap(await sb.from('notes').update(patch).eq('id', id).select().single()); },
  async remove(id) { return unwrap(await sb.from('notes').delete().eq('id', id)); },
};

export const Agenda = {
  async list() {
    return unwrap(await sb.from('agenda_events').select('*')
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true }));
  },
  async create(e) { return unwrap(await sb.from('agenda_events').insert(e).select().single()); },
  async update(id, patch) { return unwrap(await sb.from('agenda_events').update(patch).eq('id', id).select().single()); },
  async remove(id) { return unwrap(await sb.from('agenda_events').delete().eq('id', id)); },
};

/* ---------- FINANZAS ---------- */
export const Finance = {
  async profiles() {
    return unwrap(await sb.from('profiles').select('*').order('sort_order'));
  },
  async updateProfile(id, patch) {
    return unwrap(await sb.from('profiles').update(patch).eq('id', id).select().single());
  },
  async categories() {
    return unwrap(await sb.from('finance_categories').select('*').order('kind').order('sort_order'));
  },
  async subcategories() {
    return unwrap(await sb.from('finance_subcategories').select('*').order('sort_order'));
  },
  async addCategory(c) { return unwrap(await sb.from('finance_categories').insert(c).select().single()); },
  async updateCategory(id, patch) { return unwrap(await sb.from('finance_categories').update(patch).eq('id', id).select().single()); },
  async removeCategory(id) { return unwrap(await sb.from('finance_categories').delete().eq('id', id)); },
  async addSub(s) { return unwrap(await sb.from('finance_subcategories').insert(s).select().single()); },
  async updateSub(id, patch) { return unwrap(await sb.from('finance_subcategories').update(patch).eq('id', id).select().single()); },
  async removeSub(id) { return unwrap(await sb.from('finance_subcategories').delete().eq('id', id)); },
  async allTransactions(profileId) {
    return unwrap(await sb.from('finance_transactions').select('*')
      .eq('profile_id', profileId)
      .order('transaction_date', { ascending: false })
      .order('occurred_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }));
  },
  async transactions(profileId, fromDate, toDate) {
    return unwrap(await sb.from('finance_transactions').select('*')
      .eq('profile_id', profileId)
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate)
      .order('transaction_date', { ascending: false })
      .order('occurred_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }));
  },
  async addTransaction(t) {
    return unwrap(await sb.from('finance_transactions').insert(t).select().single());
  },
  async updateTransaction(id, patch) {
    return unwrap(await sb.from('finance_transactions').update(patch).eq('id', id).select().single());
  },
  async removeTransaction(id) {
    return unwrap(await sb.from('finance_transactions').delete().eq('id', id));
  },
  async budgets(profileId) {
    return unwrap(await sb.from('budgets').select('*').eq('profile_id', profileId)
      .order('kind').order('sort_order').order('created_at'));
  },
  async addBudget(b) { return unwrap(await sb.from('budgets').insert(b).select().single()); },
  async updateBudget(id, patch) { return unwrap(await sb.from('budgets').update(patch).eq('id', id).select().single()); },
  async removeBudget(id) { return unwrap(await sb.from('budgets').delete().eq('id', id)); },
  async goals(profileId) {
    return unwrap(await sb.from('savings_goals').select('*').eq('profile_id', profileId).order('created_at'));
  },
  async addGoal(g) { return unwrap(await sb.from('savings_goals').insert(g).select().single()); },
  async updateGoal(id, patch) { return unwrap(await sb.from('savings_goals').update(patch).eq('id', id).select().single()); },
  async removeGoal(id) { return unwrap(await sb.from('savings_goals').delete().eq('id', id)); },
  async debts(profileId) {
    return unwrap(await sb.from('debts').select('*').eq('profile_id', profileId).order('status').order('due_date', { nullsFirst: false }));
  },
  async addDebt(d) { return unwrap(await sb.from('debts').insert(d).select().single()); },
  async updateDebt(id, patch) { return unwrap(await sb.from('debts').update(patch).eq('id', id).select().single()); },
  async removeDebt(id) { return unwrap(await sb.from('debts').delete().eq('id', id)); },
};

/* ---------- SESIÓN DEL SUITE ---------- */
export const Session = {
  async open(profileId, days, device) {
    const token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    const expires = new Date(Date.now() + days * 864e5).toISOString();
    await unwrap(await sb.from('sessions').insert({
      token, profile_id: profileId, expires_at: expires, device: device || '',
    }).select().single());
    return { token, expires_at: expires, profile_id: profileId };
  },
  /** Devuelve la sesión si sigue vigente; null si venció o no existe. */
  async check(token) {
    if (!token) return null;
    const rows = unwrap(await sb.from('sessions').select('*')
      .eq('token', token).gt('expires_at', new Date().toISOString()).limit(1));
    return rows?.[0] || null;
  },
  async touch(token) {
    try { await sb.from('sessions').update({ last_seen: new Date().toISOString() }).eq('token', token); }
    catch { /* no es crítico */ }
  },
  async close(token) {
    if (!token) return;
    try { await sb.from('sessions').delete().eq('token', token); } catch { /* noop */ }
  },
  /** Cierra la sesión en todos los dispositivos de ese perfil. */
  async closeAll(profileId) {
    try { await sb.from('sessions').delete().eq('profile_id', profileId); } catch { /* noop */ }
  },
};

/* ---------- AJUSTES SUELTOS DEL SUITE (suite_data) ---------- */
export const Settings = {
  async read(id) {
    const rows = unwrap(await sb.from('suite_data').select('payload').eq('id', id).limit(1));
    return rows?.[0]?.payload || {};
  },
  async write(id, payload) {
    return unwrap(await sb.from('suite_data')
      .upsert({ id, payload, updated_at: new Date().toISOString() }).select().single());
  },
};

/* ---------- CHECK LIST MENSUAL ---------- */
export const Checks = {
  /** El periodo mensual usa la forma YYYY-MM; las marcas históricas no se eliminan. */
  async list(profileId, periodo) {
    return unwrap(await sb.from('budget_checks').select('*')
      .eq('profile_id', profileId).eq('period', periodo));
  },
  async mark(profileId, budgetId, period) {
    return unwrap(await sb.from('budget_checks')
      .upsert({ profile_id: profileId, budget_id: budgetId, period }, { onConflict: 'budget_id,period' })
      .select().single());
  },
  async unmark(budgetId, period) {
    return unwrap(await sb.from('budget_checks').delete().eq('budget_id', budgetId).eq('period', period));
  },
};

/* ---------- realtime ---------- */
const channels = new Map();

export function watch(name, tables, onChange) {
  unwatch(name);
  const ch = sb.channel('ashub:' + name);
  tables.forEach((table) => {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => onChange(payload));
  });
  ch.subscribe();
  channels.set(name, ch);
  return ch;
}

export function unwatch(name) {
  const ch = channels.get(name);
  if (ch) { sb.removeChannel(ch); channels.delete(name); }
}
