// AS HUB — AS FINANZAS (copiloto financiero)
import { Finance, watch, unwatch, readCache, writeCache } from '../db.js';
import {
  $, $$, html, raw, esc, money, num, toast, sheet, confirmSheet,
  todayISO, addDays, monthRange, pct,
} from '../ui.js';
import { TZ, ACCENTS, APP_VERSION } from '../config.js';
import { perfilActivo, hashPin, cambiarPin, cerrarSesion } from '../session.js';
import { bindCOPInput, formatCOPInput, parseCOP } from '../cop-input.js';

/* ============================ constantes ============================ */
const TABS = [
  { id: 'movimientos', label: 'Movimientos' },
  { id: 'presupuesto', label: 'Presupuesto' },
  { id: 'ahorros', label: 'Ahorros' },
  { id: 'categorias', label: 'Categorías' },
  { id: 'deudas', label: 'Deudas' },
  { id: 'estadisticas', label: 'Estadísticas' },
];

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_CORTOS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];

const KINDS = {
  fixed: { label: 'Gastos fijos', emoji: '📌', line: '📌' },
  variable: { label: 'Gastos variables', emoji: '🎲', line: '🔁' },
  saving: { label: 'Ahorro', emoji: '🐖', line: '🐖' },
  income: { label: 'Ingresos', emoji: '💰', line: '💰' },
};

const TX_LABEL = {
  income: 'Ingreso', expense: 'Gasto', saving: 'Ahorro', withdrawal: 'Retiro de ahorro',
};

/* Grupos del presupuesto semanal: cada categoría es independiente, el grupo
   solo ordena visualmente. */
const GROUPS = {
  need: { label: 'Necesidades', hint: 'Mercado, gasolina, transporte' },
  life: { label: 'Vida / disfrute', hint: 'Comidas por fuera, ocio, mecato' },
};

/* Semáforo por porcentaje utilizado. */
const SEMAFORO = [
  { max: 70, key: 'ok', dot: '🟢', text: 'Vas bien' },
  { max: 90, key: 'warn', dot: '🟡', text: 'Te estás acercando al límite' },
  { max: 100, key: 'hot', dot: '🟠', text: 'Casi agotaste el presupuesto' },
  { max: Infinity, key: 'over', dot: '🔴', text: 'Presupuesto agotado o excedido' },
];
const semaforo = (p) => SEMAFORO.find((s) => p < s.max);

const SLICE_COLORS = ['#e8348f', '#4a7fe0', '#a8e050', '#ffb347', '#7b5fe0',
  '#26c6a0', '#ff6b6b', '#8bd8ff', '#d5b8ff', '#b0b0a8'];

/* Palabras que delatan un gasto hormiga cuando no está en la subcategoría de mecato. */
const HORMIGA_RE = /caf[eé]|snack|antojo|mecato|golosina|dulce|helado|postre|chocolat/;

/* ============================ estado ============================ */
let root;
let state = {
  tab: 'movimientos',
  profileId: '',
  year: 0, month: 0,
  weekOffset: 0,
  profiles: [], cats: [], subs: [], tx: [], budgets: [], goals: [], debts: [],
  loaded: false,
};

/* ============================ utilidades ============================ */
// fragmento anidado: ya viene escapado por html(), no se debe volver a escapar
const H = (strings, ...values) => raw(html(strings, ...values));

const n = (v) => Number(v) || 0;
const amt = (x) => n(x.amount);
const dateAt = (iso) => new Date(iso + 'T12:00:00');
const dayNum = (iso) => Number(iso.slice(8, 10));
const diffDays = (a, b) => Math.round((dateAt(b) - dateAt(a)) / 864e5);
const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function timeOf(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

function fmtLongDay(iso) {
  const d = dateAt(iso);
  return `${d.getDate()} de ${MES_CORTO[d.getMonth()]}`;
}

/** Lunes de la semana que contiene la fecha dada. */
function weekStart(iso) {
  const d = dateAt(iso);
  return addDays(iso, -((d.getDay() + 6) % 7));
}

function weekRange(offset = 0) {
  const start = addDays(weekStart(todayISO()), 7 * offset);
  return { start, end: addDays(start, 6) };
}

function fmtWeek({ start, end }) {
  const a = dateAt(start); const b = dateAt(end);
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MESES[a.getMonth()].toLowerCase()}`;
  return `${a.getDate()} ${MES_CORTO[a.getMonth()]} – ${b.getDate()} ${MES_CORTO[b.getMonth()]}`;
}

const profile = () => state.profiles.find((p) => p.id === state.profileId) || state.profiles[0] || null;
const catById = (id) => state.cats.find((c) => c.id === id) || null;
const subById = (id) => state.subs.find((s) => s.id === id) || null;
const goalById = (id) => state.goals.find((g) => g.id === id) || null;

function range() {
  return monthRange(state.year, state.month);
}

function txBetween(from, to) {
  return state.tx.filter((t) => t.transaction_date >= from && t.transaction_date <= to);
}

function monthTx() {
  const { from, to } = range();
  return txBetween(from, to);
}

const sumBy = (list, f) => list.reduce((acc, x) => acc + n(f(x)), 0);

/** Descripciones ya usadas, de la más frecuente a la menos, para autocompletar. */
function descHistory() {
  const seen = new Map();
  state.tx.forEach((t) => {
    const d = (t.description || '').trim();
    if (!d) return;
    seen.set(d, (seen.get(d) || 0) + 1);
  });
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d).slice(0, 40);
}

/** Quiénes han reembolsado antes, para autocompletar. */
function payerHistory() {
  return [...new Set(state.tx.map((t) => (t.reimburse_by || '').trim()).filter(Boolean))];
}

/* ============================ motor de cálculo ============================
   Conceptos que nunca se mezclan:
   - gasto real: reduce el patrimonio (excluye reembolsables)
   - ahorro: sigue siendo mío, solo cambia de lugar (no es gasto)
   - reembolsable: salió de la cuenta pero vuelve (cuenta en saldo, no en presupuesto)
   - saldo: dinero en la cuenta ahora mismo
   - dinero libre: saldo menos obligaciones, presupuesto protegido y deudas       */
const isIncome = (t) => t.type === 'income';
const isExpense = (t) => t.type === 'expense';
const isSaving = (t) => t.type === 'saving';
const isWithdrawal = (t) => t.type === 'withdrawal';
const isReimbursable = (t) => isExpense(t) && !!t.reimbursable;
const refundCatId = () => state.cats.find((c) => c.slug === 'refund')?.id || null;
const isRefund = (t) => isIncome(t) && !!refundCatId() && t.category_id === refundCatId();
const isRealExpense = (t) => isExpense(t) && !t.reimbursable;
const isRealIncome = (t) => isIncome(t) && !isRefund(t);
const isFixedTx = (t) => isRealExpense(t) && t.spend_type === 'fixed';
const isVarTx = (t) => isRealExpense(t) && t.spend_type !== 'fixed';

function totals(list) {
  return {
    income: sumBy(list.filter(isRealIncome), amt),
    expense: sumBy(list.filter(isRealExpense), amt),
    fixed: sumBy(list.filter(isFixedTx), amt),
    variable: sumBy(list.filter(isVarTx), amt),
    saving: sumBy(list.filter(isSaving), amt) - sumBy(list.filter(isWithdrawal), amt),
    cashIn: sumBy(list.filter((t) => isIncome(t) || isWithdrawal(t)), amt),
    cashOut: sumBy(list.filter((t) => isExpense(t) || isSaving(t)), amt),
  };
}

/** Saldo disponible: saldo inicial más todo lo que entró menos todo lo que salió. */
function saldo() {
  const t = totals(state.tx);
  return n(profile()?.opening_balance) + t.cashIn - t.cashOut;
}

const activeBudgets = () => state.budgets.filter((b) => b.active !== false);
const fixedLines = () => activeBudgets().filter((b) => b.kind === 'fixed' && b.period !== 'week');
const savingLines = () => activeBudgets().filter((b) => b.kind === 'saving' && b.period !== 'week');
const weeklyLines = () => activeBudgets().filter((b) => b.period === 'week');
const weeklyTotal = () => sumBy(weeklyLines(), amt);

/** Un gasto fijo se da por pagado cuando hay un movimiento del mes con su
 *  subcategoría o con su nombre en la descripción. */
function fixedStatus(list) {
  return fixedLines().map((b) => {
    const key = norm(b.name);
    const hits = list.filter((t) => isExpense(t) && (
      (b.subcategory_id && t.subcategory_id === b.subcategory_id)
      || (key && norm(t.description).includes(key))));
    const paid = sumBy(hits, amt);
    return { b, hits, paid, done: hits.length > 0, pending: hits.length ? 0 : n(b.amount) };
  });
}

/** Línea semanal a la que pertenece un gasto: primero por subcategoría, luego por categoría. */
function weekLineFor(t) {
  const lines = weeklyLines();
  return lines.find((b) => b.subcategory_id && b.subcategory_id === t.subcategory_id)
    || lines.find((b) => !b.subcategory_id && b.category_id === t.category_id)
    || null;
}

function weekReport(offset = 0) {
  const { start, end } = weekRange(offset);
  // Solo gasto variable real: los fijos tienen su propio plan y los reembolsables vuelven.
  const week = txBetween(start, end).filter(isVarTx);
  const items = weeklyLines().map((b) => {
    const spent = sumBy(week.filter((t) => weekLineFor(t)?.id === b.id), amt);
    const budget = n(b.amount);
    const used = budget ? Math.round((spent / budget) * 100) : (spent ? 100 : 0);
    return { b, spent, budget, left: budget - spent, used, sem: semaforo(used) };
  });
  const other = sumBy(week.filter((t) => !weekLineFor(t)), amt);
  const groups = Object.keys(GROUPS).map((key) => {
    const its = items.filter((i) => (i.b.group_key || 'life') === key);
    return { key, ...GROUPS[key], items: its, budget: sumBy(its, (i) => i.budget), spent: sumBy(its, (i) => i.spent), left: sumBy(its, (i) => Math.max(0, i.left)) };
  });
  return {
    start, end, items, groups, other,
    budget: weeklyTotal(),
    spent: sumBy(items, (i) => i.spent),
    left: sumBy(items, (i) => Math.max(0, i.left)),
  };
}

/** Reembolsables que aún no han vuelto a la cuenta. */
function reimbPending() {
  const items = state.tx.filter((t) => isReimbursable(t) && !t.reimbursed_at);
  const by = new Map();
  items.forEach((t) => {
    const k = (t.reimburse_by || '').trim() || 'Sin indicar';
    by.set(k, (by.get(k) || 0) + amt(t));
  });
  return { items, total: sumBy(items, amt), by: [...by.entries()].sort((a, b) => b[1] - a[1]) };
}

/** Todo lo que se puede saber del mes: totales, ritmo, proyección. */
function monthEngine(year = state.year, month = state.month) {
  const { from, to } = monthRange(year, month);
  const list = txBetween(from, to);
  const t = totals(list);
  const today = todayISO();
  const daysInMonth = dayNum(to);
  let elapsed = 0;
  if (today > to) elapsed = daysInMonth;
  else if (today >= from) elapsed = dayNum(today);
  const elapsedPct = Math.round((elapsed / daysInMonth) * 100);

  const varBudget = Math.round(weeklyTotal() * (daysInMonth / 7));
  const fixed = fixedStatus(list);
  const fixedPlanned = sumBy(fixedLines(), amt);
  const fixedPaid = sumBy(fixed, (f) => f.paid);
  const fixedPending = sumBy(fixed, (f) => f.pending);
  const savingPlanned = sumBy(savingLines(), amt);

  const usedPct = varBudget ? Math.round((t.variable / varBudget) * 100) : 0;
  const dailyAvg = elapsed ? t.variable / elapsed : 0;
  const weeklyAvg = dailyAvg * 7;

  let pace;
  if (!elapsed) pace = { key: 'idle', dot: '⏳', text: 'El mes aún no empieza' };
  else if (!varBudget) pace = { key: 'idle', dot: '⚙️', text: 'Configura tu presupuesto semanal' };
  else if (usedPct >= 100) pace = { key: 'fast', dot: '🔴', text: 'Presupuesto variable agotado' };
  else if (usedPct > elapsedPct + 5) pace = { key: 'fast', dot: '🔴', text: 'Estás gastando más rápido de lo previsto' };
  else pace = { key: 'ok', dot: '🟢', text: 'Vas bien este mes' };

  const projVar = elapsed ? Math.round(dailyAvg * daysInMonth) : varBudget;
  const projExpense = fixedPaid + fixedPending + projVar;
  const projSaving = Math.max(t.saving, savingPlanned);
  const expectedIncome = Math.max(t.income, n(profile()?.base_income));
  const projFree = expectedIncome - projExpense - projSaving;
  const savingRate = t.income ? Math.round((t.saving / t.income) * 100) : 0;

  return {
    from, to, list, t, daysInMonth, elapsed, elapsedPct,
    varBudget, fixed, fixedPlanned, fixedPaid, fixedPending, savingPlanned,
    usedPct, dailyAvg, weeklyAvg, pace,
    projVar, projExpense, projSaving, expectedIncome, projFree, savingRate,
  };
}

/** Dinero realmente libre, siempre calculado a hoy. */
function freeMoney() {
  const today = todayISO();
  const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7));
  const eng = monthEngine(y, m);
  const wk = weekReport(0);
  const { to } = monthRange(y, m);
  // Semanas que faltan después de esta, dentro del mes.
  const daysAfter = Math.max(0, diffDays(wk.end, to));
  const protectedBudget = Math.round(wk.left + weeklyTotal() * (daysAfter / 7));
  const debts = sumBy(state.debts.filter((d) => d.status !== 'paid'), amt);
  const reimb = reimbPending().total;
  const s = saldo();
  return {
    saldo: s,
    fixedPending: eng.fixedPending,
    protectedBudget,
    debts,
    reimb,
    free: s - eng.fixedPending - protectedBudget - debts + reimb,
    week: wk,
    eng,
  };
}

function breakdown(list, keyOf) {
  const map = new Map();
  list.forEach((t) => {
    const { key, name, emoji } = keyOf(t);
    const prev = map.get(key) || { key, name, emoji, value: 0, count: 0 };
    prev.value += amt(t);
    prev.count += 1;
    map.set(key, prev);
  });
  return [...map.values()].sort((a, b) => b.value - a.value);
}

const byCat = (t) => {
  const c = catById(t.category_id);
  return { key: c?.id || 'sin', name: c?.name || 'Sin categoría', emoji: c?.emoji || '📦' };
};
const bySub = (t) => {
  const c = catById(t.category_id); const s = subById(t.subcategory_id);
  return {
    key: s?.id || ('cat:' + (c?.id || 'sin')),
    name: s ? `${s.name} · ${c?.name || ''}` : (c?.name || 'Sin categoría'),
    emoji: s?.emoji || c?.emoji || '📦',
  };
};

function hormigaTx(list) {
  const mecatoIds = state.subs.filter((s) => norm(s.name).includes('mecato')).map((s) => s.id);
  return list.filter((t) => isRealExpense(t)
    && (mecatoIds.includes(t.subcategory_id) || HORMIGA_RE.test(norm(t.description))));
}

/* ============================ carga ============================ */
async function loadAll({ silent = false } = {}) {
  const pid = state.profileId;
  const [profiles, cats, subs, tx, budgets, goals, debts] = await Promise.all([
    Finance.profiles(), Finance.categories(), Finance.subcategories(),
    Finance.allTransactions(pid), Finance.budgets(pid), Finance.goals(pid), Finance.debts(pid),
  ]);
  Object.assign(state, { profiles, cats, subs, tx, budgets, goals, debts, loaded: true });
  writeCache('fin:' + pid, { profiles, cats, subs, tx, budgets, goals, debts });
  aplicarAcento(profiles.find((x) => x.id === pid));
  if (!silent) toast('Finanzas al día');
  paint();
}

function hydrate() {
  const c = readCache('fin:' + state.profileId);
  if (c) Object.assign(state, c, { loaded: true });
}

/* ============================ cabecera ============================ */
function statsHTML() {
  const fm = freeMoney();
  const eng = monthEngine();
  const re = reimbPending();
  return html`
    <div class="finPace finPace--${eng.pace.key}">${eng.pace.dot} ${eng.pace.text}</div>
    <div class="finStats finStats--home">
      <div class="finStat finStat--bal">
        <span>Saldo disponible <button type="button" data-act="opening" aria-label="Ajustar saldo inicial">✎</button></span>
        <b>${money(fm.saldo)}</b>
      </div>
      <button class="finStat finStat--free" type="button" data-act="free-detail">
        <span>Dinero realmente libre <i>ver cálculo</i></span>
        <b>${money(fm.free)}</b>
      </button>
      <div class="finStat finStat--week">
        <span>Te queda esta semana</span>
        <b>${money(fm.week.left)}</b>
        <small>de ${money(fm.week.budget)} · ${fmtWeek(fm.week)}</small>
      </div>
      <div class="finStat finStat--sav">
        <span>Ahorro del mes</span>
        <b>${money(eng.t.saving)}</b>
        <small>${eng.savingRate}% de tus ingresos</small>
      </div>
      <button class="finStat finStat--re" type="button" data-act="reconcile">
        <span>Reembolsos pendientes <i>${re.items.length ? 'conciliar' : ''}</i></span>
        <b>${money(re.total)}</b>
        ${re.by.length ? H`<small>${re.by.map(([k, v]) => `${k}: ${money(v)}`).join(' · ')}</small>` : ''}
      </button>
    </div>`;
}

/* ============================ vista: MOVIMIENTOS ============================ */
function rowHTML(t) {
  const cat = catById(t.category_id);
  const sub = subById(t.subcategory_id);
  const goal = goalById(t.goal_id);
  const title = t.description || sub?.name || cat?.name || goal?.name || TX_LABEL[t.type] || 'Movimiento';
  let cls = 'finRow--out'; let sign = '− '; let icon = sub?.emoji || cat?.emoji || '💸';
  if (isIncome(t)) { cls = 'finRow--in'; sign = '+ '; }
  if (isSaving(t)) { cls = 'finRow--sav'; sign = '→ '; icon = '🐖'; }
  if (isWithdrawal(t)) { cls = 'finRow--wd'; sign = '← '; icon = '🐖'; }
  // Sin hora conocida (movimientos históricos importados) no se muestra nada.
  const meta = [
    goal ? `Meta: ${goal.name}` : null,
    cat?.name, sub?.name, timeOf(t.occurred_at),
  ].filter(Boolean).join(' · ');
  let chip = '';
  if (isReimbursable(t)) {
    chip = t.reimbursed_at
      ? H`<em class="finChip finChip--ok">✓ Reembolsado${t.reimburse_by ? ' · ' + t.reimburse_by : ''}</em>`
      : H`<em class="finChip finChip--re">↩ Reembolsable${t.reimburse_by ? ' · ' + t.reimburse_by : ''}</em>`;
  } else if (isRefund(t)) {
    chip = H`<em class="finChip finChip--ok">↩ Reembolso recibido</em>`;
  }
  return html`
    <div class="finRow ${cls}" data-tx="${t.id}">
      <div class="finRowIcon">${icon}</div>
      <div class="finRowText"><b>${title}</b><small>${meta}</small>${chip}</div>
      <div class="finRowAmt">${sign}${money(t.amount)}</div>
      <div class="finIcons">
        <button type="button" data-act="tx-edit" aria-label="Editar">✎</button>
        <button type="button" data-act="tx-del" aria-label="Eliminar">✕</button>
      </div>
    </div>`;
}

function viewMovimientos() {
  const list = monthTx();
  const t = totals(list);
  const hoy = sumBy(list.filter((x) => isRealExpense(x) && x.transaction_date === todayISO()), amt);
  const re = reimbPending();
  const days = [...new Set(list.map((x) => x.transaction_date))].sort().reverse();

  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div>
          <span class="finTag">Tu mes en movimiento</span>
          <h2>Movimientos</h2>
        </div>
      </div>

      <div class="finMini finMini--4">
        <div class="finMiniBox"><span>FIJOS</span><b>${money(t.fixed)}</b></div>
        <div class="finMiniBox"><span>VARIABLES</span><b>${money(t.variable)}</b></div>
        <div class="finMiniBox"><span>HOY</span><b>${money(hoy)}</b></div>
        <button class="finMiniBox finMiniBox--btn" type="button" data-act="reconcile">
          <span>POR REEMBOLSAR</span><b>${money(re.total)}</b>
        </button>
      </div>

      ${days.length ? raw(`<div class="finDays">${days.map((iso) => {
    const items = list.filter((x) => x.transaction_date === iso);
    const dt = totals(items);
    const d = dateAt(iso);
    return html`
          <section class="finDay">
            <div class="finDayHead">
              <div class="finDayDate">
                <b>${d.getDate()}</b>
                <span>${DIAS_CORTOS[d.getDay()]}<i>${MES_CORTO[d.getMonth()]} de ${d.getFullYear()}</i></span>
              </div>
              <div class="finDaySum">
                <span class="in">${dt.cashIn ? '+ ' + money(dt.cashIn) : money(0)}</span>
                <span class="out">${dt.cashOut ? '− ' + money(dt.cashOut) : money(0)}</span>
              </div>
            </div>
            ${raw(items.map(rowHTML).join(''))}
          </section>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Sin movimientos en ${MESES[state.month - 1]}. Toca el botón flotante “+” para registrar el primero.</div>`}
    </div>`;
}

/* ============================ vista: PRESUPUESTO ============================ */
function weekItemHTML(it) {
  return html`
    <div class="finWeekItem is-${it.sem.key}" data-budget="${it.b.id}">
      <b>${it.b.name}<i>${money(it.spent)} / ${money(it.budget)}</i></b>
      <div class="finBar"><i style="width:${Math.min(100, it.used)}%"></i></div>
      <div class="finWeekFoot">
        <span>${it.sem.dot} ${num(it.used)}% utilizado</span>
        ${it.left >= 0
    ? H`<span class="left">Te quedan ${money(it.left)}</span>`
    : H`<span class="over">Excedido ${money(-it.left)}</span>`}
      </div>
      <div class="finWeekState">
        <small>${it.sem.text}</small>
        <span class="finIcons">
          <button type="button" data-act="wk-edit" aria-label="Editar">✎</button>
          <button type="button" data-act="bud-del" aria-label="Eliminar">✕</button>
        </span>
      </div>
    </div>`;
}

function viewPresupuesto() {
  const p = profile();
  const eng = monthEngine();
  const fm = freeMoney();
  const wk = weekReport(state.weekOffset);
  const weeksLabel = (eng.daysInMonth / 7).toFixed(1).replace('.', ',');

  const fixedRows = eng.fixed.map(({ b, done, paid }) => html`
    <div class="finLine ${done ? 'is-done' : ''}" data-budget="${b.id}">
      <span><i class="finDot">${done ? '✓' : '○'}</i> ${b.name}${done && paid !== n(b.amount) ? H`<small> pagado ${money(paid)}</small>` : ''}</span>
      <b>${money(b.amount)}</b>
      <span class="finIcons" style="flex:none">
        <button type="button" data-act="bud-edit" aria-label="Editar">✎</button>
        <button type="button" data-act="bud-del" aria-label="Eliminar">✕</button>
      </span>
    </div>`).join('');

  const savingRows = savingLines().map((b) => html`
    <div class="finLine" data-budget="${b.id}">
      <span>🐖 ${b.name}</span>
      <b>${money(b.amount)}</b>
      <span class="finIcons" style="flex:none">
        <button type="button" data-act="bud-edit" aria-label="Editar">✎</button>
        <button type="button" data-act="bud-del" aria-label="Eliminar">✕</button>
      </span>
    </div>`).join('');

  const groupHTML = (g) => html`
    <section class="finGroup finGroup--${g.key}">
      <div class="finGroupHead">
        <div><b>${g.label}</b><small>${g.hint}</small></div>
        <i>${money(g.spent)} / ${money(g.budget)}</i>
      </div>
      ${g.items.length
    ? raw(g.items.map(weekItemHTML).join(''))
    : H`<div class="finEmpty" style="padding:14px">Sin categorías en este grupo.</div>`}
    </section>`;

  return html`
    <div class="finTwo">
      <div class="finPanel">
        <div class="finPanelHead">
          <div>
            <span class="finTag finTag--lime">Ritmo semanal</span>
            <h2>Esta semana</h2>
          </div>
          <div class="finWeekNav">
            <button class="finArrow" type="button" data-act="wk-prev" aria-label="Semana anterior">‹</button>
            <span>${state.weekOffset === 0 ? 'Semana actual' : state.weekOffset === -1 ? 'Semana pasada' : state.weekOffset === 1 ? 'Próxima semana' : 'Semana'} · ${fmtWeek(wk)}</span>
            <button class="finArrow" type="button" data-act="wk-next" aria-label="Semana siguiente">›</button>
          </div>
        </div>

        <div class="finWeekHero ${wk.left <= 0 && wk.budget ? 'is-over' : ''}">
          <span>${wk.left > 0 ? 'Te quedan' : 'Ya no te queda'}</span>
          <b>${money(Math.max(0, wk.left))}</b>
          <small>para gastar esta semana · gastado ${money(wk.spent)} de ${money(wk.budget)}</small>
        </div>

        ${wk.items.length
    ? raw(wk.groups.map(groupHTML).join(''))
    : H`<div class="finEmpty">Agrega categorías semanales para ver cuánto te queda.</div>`}

        ${wk.other ? H`<p class="finNote">Fuera del presupuesto semanal: <b>${money(wk.other)}</b> (personal, imprevistos, varios).</p>` : ''}

        <div class="finPanelFoot">
          <button class="finBtn finBtn--sm" type="button" data-act="wk-new">+ Categoría semanal</button>
        </div>
      </div>

      <div class="finPanel">
        <div class="finPanelHead">
          <div><span class="finTag">Plan del mes</span><h2>Presupuesto mensual</h2><p>${MESES[state.month - 1]} de ${state.year}</p></div>
        </div>

        <div class="finBudgetGrid">
          <div class="finBox finBox--in">
            <span>💰 Ingreso esperado <button type="button" data-act="base" aria-label="Editar ingreso base">✎</button></span>
            <b>${money(p?.base_income)}</b>
            <small>Registrado este mes: ${money(eng.t.income)}</small>
          </div>
          <div class="finBox finBox--fix">
            <span>📌 Gastos fijos</span>
            <b>${money(eng.fixedPlanned)}</b>
            <small>Pagado ${money(eng.fixedPaid)} · pendiente ${money(eng.fixedPending)}</small>
          </div>
          <div class="finBox finBox--var">
            <span>🎲 Variables del mes</span>
            <b>${money(eng.varBudget)}</b>
            <small>${money(weeklyTotal())} por semana × ${weeksLabel} · usado ${money(eng.t.variable)}</small>
          </div>
          <div class="finBox finBox--sav">
            <span>🐖 Ahorro planeado</span>
            <b>${money(eng.savingPlanned)}</b>
            <small>Ahorrado este mes: ${money(eng.t.saving)}</small>
          </div>
          <button class="finBox finBox--total" type="button" data-act="free-detail">
            <span>✦ Dinero realmente libre</span>
            <b>${money(fm.free)}</b>
            <small>Saldo ${money(fm.saldo)} − fijos pendientes − presupuesto protegido − deudas + reembolsos · toca para ver el cálculo</small>
          </button>
        </div>

        <div class="finLines">
          <p class="finGroupTitle">📌 Gastos fijos del mes · ${money(eng.fixedPlanned)}</p>
          ${raw(fixedRows)}
          ${eng.fixed.length ? '' : H`<div class="finEmpty" style="padding:14px">Sin gastos fijos configurados.</div>`}
          <div class="finPanelFoot"><button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="bud-new" data-kind="fixed">+ Gasto fijo</button></div>

          <p class="finGroupTitle">🐖 Ahorro planeado · ${money(eng.savingPlanned)}</p>
          ${raw(savingRows)}
          ${savingLines().length ? '' : H`<div class="finEmpty" style="padding:14px">Sin ahorro planeado.</div>`}
          <div class="finPanelFoot"><button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="bud-new" data-kind="saving">+ Ahorro planeado</button></div>
        </div>
      </div>
    </div>`;
}

/* ============================ vista: AHORROS ============================ */
function viewAhorros() {
  const eng = monthEngine();
  const totalSaved = sumBy(state.goals, (g) => g.current);
  const totalTarget = sumBy(state.goals, (g) => g.target);
  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div><span class="finTag">Paso a paso</span><h2>Metas de ahorro</h2></div>
        <button class="finBtn" type="button" data-act="goal-new">+ Nueva meta</button>
      </div>

      <div class="finMini">
        <div class="finMiniBox"><span>AHORRADO TOTAL</span><b>${money(totalSaved)}</b></div>
        <div class="finMiniBox"><span>META TOTAL</span><b>${money(totalTarget)}</b></div>
        <div class="finMiniBox"><span>ESTE MES</span><b>${money(eng.t.saving)}</b></div>
      </div>

      ${state.goals.length ? raw(`<div class="finGoals">${state.goals.map((g) => {
    const p2 = pct(n(g.current), n(g.target));
    return html`
        <article class="finGoal" data-goal="${g.id}">
          <div class="finGoalImg">
            ${g.image_url ? raw(`<img src="${esc(g.image_url)}" alt="">`) : ''}
            <em>✦ Imagen de tu meta ✦</em>
            <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-img">Añadir imagen</button>
          </div>
          <div class="finGoalBody">
            <div class="finGoalTop"><b>🎯 ${g.name}</b><i>${num(p2)}%</i></div>
            <div class="finBar"><i style="width:${p2}%"></i></div>
            <p class="finGoalNums">${money(g.current)} / ${money(g.target)}</p>
            <p class="finGoalDate">${g.target_date ? 'Fecha objetivo: ' + g.target_date + ' · ' : ''}Faltan ${money(Math.max(0, n(g.target) - n(g.current)))}</p>
            <div class="finGoalActions">
              <button class="finBtn finBtn--sm" type="button" data-act="goal-in">+ Ingresar ahorro</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-out">Retirar</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-edit">Editar</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-del">Eliminar</button>
            </div>
          </div>
        </article>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Todavía no tienes metas. Crea la primera con “+ Nueva meta”.</div>`}
      <p class="finNote">Ahorrar no es gastar: cada ingreso a una meta crea un movimiento de tipo <b>Ahorro</b> que baja del saldo disponible sin sumar a tus gastos.</p>
    </div>`;
}

/* ============================ vista: CATEGORÍAS ============================ */
function viewCategorias() {
  const section = (title, emoji, cats, kindForNew) => {
    return html`
      <section class="finCatSection">
        <div class="finCatHead">
          <h3>${emoji} ${title}</h3>
          <button class="finBtn finBtn--sm" type="button" data-act="cat-new" data-kind="${kindForNew}">+ Categoría</button>
        </div>
        ${cats.length ? raw(`<div class="finCats">${cats.map((c) => {
      const subs = state.subs.filter((s) => s.category_id === c.id);
      return html`
          <article class="finCat" data-cat="${c.id}">
            <b>${c.emoji || '📦'} ${c.name}</b>
            <div class="finCatBtns">
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="cat-edit">Editar</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="cat-del">Eliminar</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="sub-new">+ Subcategoría</button>
            </div>
            ${raw(subs.map((s) => html`
              <div class="finSub" data-sub="${s.id}">
                <span>${s.emoji || '•'} ${s.name}</span>
                <span class="finIcons">
                  <button type="button" data-act="sub-edit" aria-label="Editar">✎</button>
                  <button type="button" data-act="sub-del" aria-label="Eliminar">✕</button>
                </span>
              </div>`).join(''))}
          </article>`;
    }).join('')}</div>`) : H`<div class="finEmpty">Sin categorías en este grupo.</div>`}
      </section>`;
  };

  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div><span class="finTag">Mapa de gastos</span><h2>Categorías</h2></div>
      </div>
      ${raw(section('Gastos', '💸', state.cats.filter((c) => c.kind === 'fixed' || c.kind === 'variable'), 'variable'))}
      ${raw(section('Ingresos', KINDS.income.emoji, state.cats.filter((c) => c.kind === 'income'), 'income'))}
    </div>`;
}

/* ============================ vista: DEUDAS ============================ */
function debtHTML(d) {
  const paid = d.status === 'paid';
  return html`
    <article class="finDebt ${paid ? 'is-paid' : ''}" data-debt="${d.id}">
      <div class="finDebtTop">
        <span class="finDebtState">${paid ? '✓ PAGADA' : '⏳ PENDIENTE'}</span>
        <span class="finDebtAmt">${money(d.amount)}</span>
      </div>
      <b>${d.person}</b>
      <p>${d.concept || 'Sin concepto'}</p>
      <small>Creada ${d.created_date || '—'}${paid && d.paid_at ? ' · pagada ' + d.paid_at.slice(0, 10) : ''}</small>
      ${!paid && d.due_date ? H`<p class="finDebtNext">📅 Próximo pago: <b>${d.due_date}</b>${d.due_date < todayISO() ? ' · vencida' : ''}</p>` : ''}
      <div class="finDebtActions">
        <button class="finBtn finBtn--sm ${paid ? 'finBtn--plain' : ''}" type="button" data-act="debt-toggle">${paid ? 'Marcar pendiente' : '✓ Marcar como pagada'}</button>
        <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="debt-edit">Editar</button>
        <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="debt-del">Eliminar</button>
      </div>
    </article>`;
}

function viewDeudas() {
  const pendientes = state.debts.filter((d) => d.status !== 'paid')
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  const pagadas = state.debts.filter((d) => d.status === 'paid')
    .sort((a, b) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')));
  const total = sumBy(pendientes, amt);
  const historico = sumBy(pagadas, amt);
  const next = pendientes.find((d) => d.due_date);
  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div><span class="finTag finTag--lime">Obligaciones</span><h2>Deudas</h2></div>
        <button class="finBtn" type="button" data-act="debt-new">+ Nueva deuda</button>
      </div>

      <div class="finMini">
        <div class="finMiniBox finMiniBox--pink"><span>DEUDA PENDIENTE TOTAL</span><b>${money(total)}</b></div>
        <div class="finMiniBox"><span>PAGADA HISTÓRICAMENTE</span><b>${money(historico)}</b></div>
        <div class="finMiniBox"><span>PRÓXIMO PAGO</span><b>${next ? next.due_date : '—'}</b>${next ? H`<small>${next.person} · ${money(next.amount)}</small>` : ''}</div>
      </div>

      ${pendientes.length
    ? H`<div class="finDebts">${raw(pendientes.map(debtHTML).join(''))}</div>`
    : H`<div class="finEmpty">Sin deudas pendientes. 🎉</div>`}

      ${pagadas.length ? H`
        <details class="finDetails" style="margin-top:18px">
          <summary>▸ Deudas archivadas (${num(pagadas.length)}) · ${money(historico)}</summary>
          <div class="finDebts" style="padding-top:12px">${raw(pagadas.map(debtHTML).join(''))}</div>
        </details>` : ''}
    </div>`;
}

/* ============================ vista: ESTADÍSTICAS ============================ */
function donutHTML(slices, total, caption) {
  const R = 45; const W = 27; const C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = slices.map((s, i) => {
    const dash = total ? (n(s.value) / total) * C : 0;
    const el = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${SLICE_COLORS[i % SLICE_COLORS.length]}"
      stroke-width="${W}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}"
      stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    acc += dash;
    return el;
  }).join('');
  return html`
    <figure class="finDonut">
      ${raw(`<svg viewBox="0 0 120 120" width="184" height="184" aria-hidden="true">
        <circle cx="60" cy="60" r="${R}" fill="none" stroke="#efeee2" stroke-width="${W}"/>${arcs}
        <circle cx="60" cy="60" r="${R - W / 2}" fill="#fff"/></svg>`)}
      <figcaption><span>${caption}</span><b>${money(total)}</b></figcaption>
    </figure>`;
}

function chartCard({ tag, title, slices, total, lead }) {
  const top = slices[0];
  return html`
    <div class="finPanel">
      <div class="finPanelHead"><div><span class="finTag finTag--lime">${tag}</span><h2>${title}</h2></div></div>
      ${top ? H`<p class="finInsight">${lead} <b>${top.emoji} ${top.name}</b>, con <b>${money(top.value)}</b>
        (${(total ? (top.value / total) * 100 : 0).toFixed(1)}%).</p>` : ''}
      ${slices.length ? H`
        <div class="finDonutWrap">
          ${raw(donutHTML(slices, total, 'TOTAL'))}
          <div class="finLegend">
            ${raw(slices.slice(0, 8).map((s, i) => html`
              <div>
                <i style="background:${SLICE_COLORS[i % SLICE_COLORS.length]}"></i>
                <span>${s.emoji} ${s.name}</span>
                <b>${(total ? (s.value / total) * 100 : 0).toFixed(1)}%</b>
              </div>`).join(''))}
          </div>
        </div>` : H`<div class="finEmpty">Sin datos en este periodo.</div>`}
    </div>`;
}

function barListHTML(rows, total) {
  return html`<div class="finBars">${raw(rows.map((r) => html`
    <div class="finBarRow">
      <span>${r.emoji} ${r.name}</span>
      <b>${money(r.value)}</b>
      <div class="finBar"><i style="width:${pct(r.value, total)}%"></i></div>
      <small>${pct(r.value, total)}% · ${num(r.count)} ${r.count === 1 ? 'movimiento' : 'movimientos'}</small>
    </div>`).join(''))}</div>`;
}

function viewEstadisticas() {
  const eng = monthEngine();
  const fm = freeMoney();
  const real = eng.list.filter(isRealExpense);
  const label = `${MESES[state.month - 1]} de ${state.year}`;

  const gastos = breakdown(real, byCat);
  const subs = breakdown(real, bySub).slice(0, 10);

  // Comparación con el mes anterior, por categoría.
  const py = state.month === 1 ? state.year - 1 : state.year;
  const pm = state.month === 1 ? 12 : state.month - 1;
  const prevEng = monthEngine(py, pm);
  const prevReal = prevEng.list.filter(isRealExpense);
  const prevMap = new Map(breakdown(prevReal, byCat).map((r) => [r.key, r]));
  const curMap = new Map(gastos.map((r) => [r.key, r]));
  const keys = new Set([...prevMap.keys(), ...curMap.keys()]);
  const cmp = [...keys].map((k) => {
    const c = curMap.get(k); const p = prevMap.get(k);
    const cur = c?.value || 0; const prev = p?.value || 0;
    return { name: (c || p).name, emoji: (c || p).emoji, cur, prev, delta: cur - prev };
  });
  const up = cmp.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta);
  const down = cmp.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);

  const hormiga = hormigaTx(eng.list);
  const hormigaTotal = sumBy(hormiga, amt);
  const hormigaAvg = hormiga.length ? hormigaTotal / hormiga.length : 0;

  const cmpRow = (r) => html`
    <div class="finCmpRow">
      <span>${r.emoji} ${r.name}</span>
      <small>${money(r.prev)} → ${money(r.cur)}</small>
      <b class="${r.delta > 0 ? 'up' : 'down'}">${r.delta > 0 ? '▲ +' : '▼ −'}${money(Math.abs(r.delta))}</b>
    </div>`;

  return html`
    <div class="finPanel" style="margin-bottom:20px">
      <div class="finPanelHead">
        <div><span class="finTag">Radiografía</span><h2>Estadísticas</h2><p>${label}</p></div>
      </div>
      <div class="finStats finStats--six">
        <div class="finStat finStat--in"><span>Ingresos del mes</span><b>${money(eng.t.income)}</b><small>sin contar reembolsos</small></div>
        <div class="finStat finStat--out"><span>Gastos reales</span><b>${money(eng.t.expense)}</b><small>fijos ${money(eng.t.fixed)} · variables ${money(eng.t.variable)}</small></div>
        <div class="finStat finStat--sav"><span>Ahorros realizados</span><b>${money(eng.t.saving)}</b><small>no cuentan como gasto</small></div>
        <div class="finStat finStat--bal"><span>Saldo disponible</span><b>${money(fm.saldo)}</b><small>hoy, en la cuenta</small></div>
        <div class="finStat finStat--free"><span>Dinero realmente libre</span><b>${money(fm.free)}</b><small>sin tocar obligaciones ni plan</small></div>
        <div class="finStat"><span>Tasa de ahorro</span><b>${eng.savingRate}%</b><small>ahorro ÷ ingresos × 100</small></div>
      </div>
    </div>

    <div class="finTwo" style="margin-bottom:20px">
      <div class="finPanel">
        <div class="finPanelHead"><div><span class="finTag finTag--lime">¿Voy bien?</span><h2>Ritmo del mes</h2></div></div>
        <div class="finRhythm">
          <div class="finRhythmRow">
            <span>Ha transcurrido <b>${eng.elapsedPct}%</b> del mes</span>
            <div class="finBar finBar--thin"><i style="width:${eng.elapsedPct}%"></i></div>
          </div>
          <div class="finRhythmRow">
            <span>Has utilizado <b>${eng.usedPct}%</b> de tu presupuesto variable</span>
            <div class="finBar finBar--thin ${eng.usedPct > eng.elapsedPct + 5 ? 'is-over' : ''}"><i style="width:${Math.min(100, eng.usedPct)}%"></i></div>
          </div>
          <div class="finPace finPace--${eng.pace.key}" style="margin:6px 0 0">${eng.pace.dot} ${eng.pace.text}</div>
        </div>
        <div class="finMini" style="margin-top:16px">
          <div class="finMiniBox"><span>PROMEDIO DIARIO</span><b>${money(Math.round(eng.dailyAvg))}</b></div>
          <div class="finMiniBox"><span>PROMEDIO SEMANAL</span><b>${money(Math.round(eng.weeklyAvg))}</b></div>
          <div class="finMiniBox"><span>PRESUPUESTO VARIABLE</span><b>${money(eng.varBudget)}</b></div>
        </div>
        <p class="finNote">Solo cuenta el gasto variable real: los fijos se pagan una vez y los reembolsables no son tuyos.</p>
      </div>

      <div class="finPanel">
        <div class="finPanelHead"><div><span class="finTag finTag--lime">Si sigues así</span><h2>Proyección de ${MESES[state.month - 1].toLowerCase()}</h2></div></div>
        <div class="finProj">
          <div class="finProjRow"><span>Gasto proyectado</span><b>${money(eng.projExpense)}</b><small>fijos ${money(eng.fixedPaid + eng.fixedPending)} + variables ${money(eng.projVar)}</small></div>
          <div class="finProjRow"><span>Ahorro proyectado</span><b>${money(eng.projSaving)}</b><small>lo mayor entre ahorrado y planeado</small></div>
          <div class="finProjRow ${eng.projFree < 0 ? 'is-neg' : ''}"><span>Disponible proyectado</span><b>${money(eng.projFree)}</b><small>ingreso esperado ${money(eng.expectedIncome)} − gasto − ahorro</small></div>
        </div>
        <p class="finNote">Usa tu promedio diario de gasto variable, los fijos que faltan por pagar y el ahorro planeado. Cambia sola con cada movimiento.</p>
      </div>
    </div>

    <div class="finTwo" style="margin-bottom:20px">
      ${raw(chartCard({
    tag: '¿A dónde se fue?', title: 'Gasto por categoría', slices: gastos,
    total: eng.t.expense, lead: 'Tu mayor categoría de gasto es',
  }))}
      <div class="finPanel">
        <div class="finPanelHead"><div><span class="finTag finTag--lime">Al detalle</span><h2>Gasto por subcategoría</h2></div></div>
        ${subs.length ? raw(barListHTML(subs, eng.t.expense)) : H`<div class="finEmpty">Sin gastos este mes.</div>`}
      </div>
    </div>

    <div class="finTwo">
      <div class="finPanel">
        <div class="finPanelHead"><div><span class="finTag finTag--lime">Mes anterior</span><h2>Comparación</h2><p>${MESES[pm - 1]} ${money(prevEng.t.expense)} → ${MESES[state.month - 1]} ${money(eng.t.expense)}</p></div></div>
        ${cmp.length ? H`
          <p class="finGroupTitle">▲ Categorías que aumentaron</p>
          ${up.length ? raw(up.map(cmpRow).join('')) : H`<p class="finNote" style="margin:4px 0 10px">Ninguna.</p>`}
          <p class="finGroupTitle">▼ Categorías que disminuyeron</p>
          ${down.length ? raw(down.map(cmpRow).join('')) : H`<p class="finNote" style="margin:4px 0 10px">Ninguna.</p>`}` : H`<div class="finEmpty">Sin datos para comparar.</div>`}
      </div>

      <div class="finPanel">
        <div class="finPanelHead"><div><span class="finTag finTag--lime">Gastos hormiga</span><h2>Lo pequeño suma</h2></div></div>
        <div class="finMini">
          <div class="finMiniBox"><span>TOTAL DEL MES</span><b>${money(hormigaTotal)}</b></div>
          <div class="finMiniBox"><span>MOVIMIENTOS</span><b>${num(hormiga.length)}</b></div>
          <div class="finMiniBox"><span>PROMEDIO</span><b>${money(Math.round(hormigaAvg))}</b></div>
        </div>
        ${hormiga.length ? H`
          <p class="finInsight">Mecato, cafés, snacks y antojos se llevan <b>${pct(hormigaTotal, eng.t.variable)}%</b> de tu gasto variable.
          A este ritmo son <b>${money(Math.round(eng.elapsed ? (hormigaTotal / eng.elapsed) * eng.daysInMonth : 0))}</b> al mes.</p>
          ${raw(barListHTML(breakdown(hormiga, (t) => ({ key: norm(t.description) || 'x', name: t.description || 'Sin descripción', emoji: subById(t.subcategory_id)?.emoji || '🍫' })).slice(0, 8), hormigaTotal))}`
    : H`<div class="finEmpty">Sin gastos hormiga este mes. 👏</div>`}
        <p class="finNote">Los gastos reembolsables (como el parqueadero del trabajo) no entran aquí.</p>
      </div>
    </div>`;
}

/* ============================ pintado ============================ */
const VIEWS = {
  movimientos: viewMovimientos,
  presupuesto: viewPresupuesto,
  ahorros: viewAhorros,
  categorias: viewCategorias,
  deudas: viewDeudas,
  estadisticas: viewEstadisticas,
};

function paint() {
  if (!root) return;
  const p = profile();
  root.innerHTML = html`
    <section class="fin">
      <header class="finTop">
        <div class="finBrand">
          <span class="finAvatar">AS</span>
          <div>
            <h1>FINANZAS</h1>
            <p class="finWho"><i>◆</i> ${p?.name || 'Perfil'}${p?.account_label ? ' · ' + p.account_label : ''}</p>
          </div>
        </div>
        <div class="finTopRight">
          <div class="finTopBtns">
            <button class="finBtn finBtn--plain" type="button" data-act="tools">Exportar</button>
          </div>
          <small>✓ Sincronizado · PC + celular</small>
        </div>
      </header>

      <div class="finMonth">
        <button class="finArrow" type="button" data-act="prev" aria-label="Mes anterior">‹</button>
        <span class="finMonthName">${MESES[state.month - 1]} de ${state.year}</span>
        <button class="finArrow" type="button" data-act="next" aria-label="Mes siguiente">›</button>
      </div>

      ${raw(statsHTML())}

      <nav class="finTabs">
        ${raw(TABS.map((t) => `<button type="button" data-tab="${t.id}"
          aria-current="${state.tab === t.id}">${esc(t.label)}</button>`).join(''))}
      </nav>

      <div class="finBody">${raw((VIEWS[state.tab] || viewMovimientos)())}</div>
    </section>
    <button class="finFab" type="button" data-act="tx-new" aria-label="Nuevo movimiento">+</button>`;
}

/* ============================ acento de color ============================ */
/** Pinta la interfaz con el acento elegido por el perfil. */
function aplicarAcento(perfil) {
  const a = ACCENTS[perfil?.accent] || ACCENTS.lima;
  const raiz = document.documentElement.style;
  raiz.setProperty('--fn-lime', a.base);
  raiz.setProperty('--fn-lime-deep', a.deep);
  raiz.setProperty('--fn-lime-soft', a.soft);
}

function limpiarAcento() {
  const raiz = document.documentElement.style;
  ['--fn-lime', '--fn-lime-deep', '--fn-lime-soft'].forEach((v) => raiz.removeProperty(v));
}

/* ============================ exportar a PDF ============================ */
/** Arma una hoja imprimible y abre el diálogo del sistema (Guardar como PDF). */
function exportarPDF(rango) {
  const p = profile();
  const hoy = todayISO();
  let lista = state.tx;
  let titulo = 'Todo el historial';

  if (rango === 'mes') {
    lista = monthTx();
    titulo = `${MESES[state.month - 1]} de ${state.year}`;
  } else if (rango === 'anio') {
    const y = String(state.year);
    lista = state.tx.filter((t) => t.transaction_date.startsWith(y));
    titulo = `Año ${y}`;
  }

  lista = [...lista].sort((a, b) => (a.transaction_date < b.transaction_date ? 1 : -1));
  const t = totals(lista);

  const filas = lista.map((x) => {
    const c = catById(x.category_id); const sub = subById(x.subcategory_id); const g = goalById(x.goal_id);
    let tipo = TX_LABEL[x.type] || x.type;
    if (isReimbursable(x)) tipo += x.reimbursed_at ? ' (reembolsado)' : ' (reembolsable)';
    const signo = isIncome(x) || isWithdrawal(x) ? '+' : '−';
    return `<tr>
      <td>${esc(x.transaction_date)}</td>
      <td>${esc(x.description || sub?.name || c?.name || g?.name || 'Movimiento')}</td>
      <td>${esc(g ? 'Meta: ' + g.name : [c?.name, sub?.name].filter(Boolean).join(' · '))}</td>
      <td>${esc(tipo)}</td>
      <td class="r ${x.type}">${signo} ${esc(money(x.amount))}</td>
    </tr>`;
  }).join('');

  const deudas = state.debts.filter((d) => d.status !== 'paid');
  const plan = activeBudgets();

  const hoja = document.createElement('div');
  hoja.id = 'printArea';
  hoja.innerHTML = `
    <header>
      <h1>AS FINANZAS</h1>
      <p><b>${esc(p?.name || '')}</b>${p?.account_label ? ' · ' + esc(p.account_label) : ''}</p>
      <p>${esc(titulo)} · generado el ${esc(hoy)} · AS Suite v${esc(APP_VERSION)}</p>
    </header>
    <table class="tot">
      <tr><th>Ingresos</th><th>Gastos reales</th><th>Ahorro</th><th>Balance</th></tr>
      <tr><td>${esc(money(t.income))}</td><td>${esc(money(t.expense))}</td><td>${esc(money(t.saving))}</td><td>${esc(money(t.income - t.expense - t.saving))}</td></tr>
    </table>
    <h2>Movimientos (${lista.length})</h2>
    ${lista.length ? `<table class="mov">
      <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Tipo</th><th class="r">Monto</th></tr></thead>
      <tbody>${filas}</tbody></table>` : '<p>Sin movimientos en este rango.</p>'}
    ${plan.length ? `<h2>Plan</h2>
      <table class="mov"><thead><tr><th>Obligación</th><th>Grupo</th><th>Frecuencia</th><th class="r">Monto</th></tr></thead>
      <tbody>${plan.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(KINDS[b.kind]?.label || b.kind)}</td>
        <td>${b.period === 'week' ? 'Semanal' : 'Mensual'}</td>
        <td class="r">${esc(money(b.amount))}</td></tr>`).join('')}</tbody></table>` : ''}
    ${deudas.length ? `<h2>Deudas pendientes</h2>
      <table class="mov"><thead><tr><th>Persona</th><th>Concepto</th><th>Vence</th><th class="r">Monto</th></tr></thead>
      <tbody>${deudas.map((d) => `<tr><td>${esc(d.person)}</td><td>${esc(d.concept || '')}</td>
        <td>${esc(d.due_date || '—')}</td><td class="r">${esc(money(d.amount))}</td></tr>`).join('')}</tbody></table>` : ''}
    <footer>Documento generado por AS Suite para uso personal.</footer>`;

  document.getElementById('printArea')?.remove();
  document.body.appendChild(hoja);
  document.body.classList.add('is-printing');

  const limpiar = () => {
    document.body.classList.remove('is-printing');
    hoja.remove();
    window.removeEventListener('afterprint', limpiar);
  };
  window.addEventListener('afterprint', limpiar);
  setTimeout(() => { window.print(); setTimeout(limpiar, 1200); }, 60);
}

/* ============================ menú de Finanzas ============================ */
function accionMenu(m) {
  const p = profile();

  if (m === 'nombre') {
    return simpleSheet({
      title: 'Cambiar nombre de usuario',
      fields: [
        { key: 'name', label: 'Nombre', value: p?.name || '' },
        { key: 'emoji', label: 'Emoji', value: p?.emoji || '👤' },
        { key: 'account_label', label: 'Cuenta asociada', value: p?.account_label || '', placeholder: 'Bancolombia Ahorros' },
      ],
      onSave: (v) => Finance.updateProfile(state.profileId, {
        name: v.name.trim() || p?.name,
        emoji: v.emoji.trim() || '👤',
        account_label: v.account_label.trim(),
      }),
    });
  }

  if (m === 'pin') return pinSheet();

  if (m === 'pdf') {
    return sheet({
      title: 'Exportar a PDF',
      body: html`
        <p class="sheetText">Se abre el diálogo de impresión: elige <b>Guardar como PDF</b>.
        Funciona igual en el computador y en el celular.</p>
        <div class="finMenu">
          <button class="finMenuItem" type="button" data-r="mes">
            <i>📅</i><span><b>${MESES[state.month - 1]} de ${state.year}</b><small>Solo el mes que estás viendo</small></span>
          </button>
          <button class="finMenuItem" type="button" data-r="anio">
            <i>🗓️</i><span><b>Año ${state.year}</b><small>Los doce meses</small></span>
          </button>
          <button class="finMenuItem" type="button" data-r="todo">
            <i>📚</i><span><b>Todo el historial</b><small>Cada movimiento registrado</small></span>
          </button>
        </div>`,
      onOpen: ({ root: r, close }) => {
        $$('[data-r]', r).forEach((b) => b.addEventListener('click', () => {
          close();
          setTimeout(() => exportarPDF(b.dataset.r), 220);
        }));
      },
      actions: [{ label: 'Cancelar', onClick: ({ close }) => close() }],
    });
  }

  if (m === 'salir') {
    return confirmSheet('Cerrar sesión', 'Tendrás que volver a escribir tu PIN en este dispositivo.', async () => {
      await cerrarSesion();
      location.reload();
    });
  }
}

function pinSheet() {
  sheet({
    title: 'Cambiar PIN de seguridad',
    body: html`
      <div class="finForm">
        <div class="finField"><label>PIN actual</label>
          <input type="password" inputmode="numeric" maxlength="4" data-f="viejo" placeholder="••••"></div>
        <div class="finField"><label>PIN nuevo</label>
          <input type="password" inputmode="numeric" maxlength="4" data-f="nuevo" placeholder="••••"></div>
        <div class="finField"><label>Repite el PIN nuevo</label>
          <input type="password" inputmode="numeric" maxlength="4" data-f="repite" placeholder="••••"></div>
        <p class="sheetText" style="font-size:12.5px;color:var(--fn-mute)">
        El PIN nunca se guarda tal cual: se convierte en un hash antes de salir de tu dispositivo.</p>
      </div>`,
    onOpen: ({ root: r, close }) => {
      r.__save = async () => {
        const val = (f) => $(`[data-f="${f}"]`, r).value.trim();
        const p = profile();
        if (!/^\d{4}$/.test(val('nuevo'))) return toast('El PIN nuevo debe tener 4 dígitos', 'err');
        if (val('nuevo') !== val('repite')) return toast('Los dos PIN nuevos no coinciden', 'err');
        const actual = await hashPin(state.profileId, val('viejo'));
        if (p?.pin_hash && actual !== p.pin_hash) return toast('El PIN actual no es correcto', 'err');
        try {
          const nuevoHash = await cambiarPin(state.profileId, val('nuevo'));
          if (p) p.pin_hash = nuevoHash;
          close();
          toast('PIN actualizado ✓');
        } catch { toast('No se pudo guardar el PIN', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Guardar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

/* ============================ hojas ============================ */
const field = (label, inner) => html`<div class="finField"><label>${label}</label>${raw(inner)}</div>`;

function optionList(items, selected, mapper) {
  return items.map((i) => {
    const { value, label } = mapper(i);
    return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

/** Efecto de un movimiento sobre el saldo de su meta (+ ingreso, − retiro). */
const goalDelta = (t) => (isSaving(t) ? amt(t) : isWithdrawal(t) ? -amt(t) : 0);

async function applyGoal(goalId, delta) {
  const g = goalById(goalId);
  if (!g || !delta) return;
  await Finance.updateGoal(g.id, { current: Math.max(0, n(g.current) + delta) });
}

/** Tipo de gasto según categoría (fijos mensuales) o presupuesto fijo vinculado. */
function spendTypeFor(type, categoryId, subcategoryId) {
  if (type === 'income') return 'income';
  if (type === 'saving' || type === 'withdrawal') return 'saving';
  if (catById(categoryId)?.kind === 'fixed') return 'fixed';
  if (subcategoryId && fixedLines().some((b) => b.subcategory_id === subcategoryId)) return 'fixed';
  return 'variable';
}

function txSheet(tx) {
  const editing = !!tx;
  const data = {
    type: tx?.type || 'expense',
    amount: tx ? n(tx.amount) : '',
    date: tx?.transaction_date || todayISO(),
    category_id: tx?.category_id || '',
    subcategory_id: tx?.subcategory_id || '',
    goal_id: tx?.goal_id || state.goals[0]?.id || '',
    description: tx?.description || '',
    reimbursable: !!tx?.reimbursable,
    reimburse_by: tx?.reimburse_by || '',
  };
  const seg = data.type === 'income' ? 'income' : (data.type === 'expense' ? 'expense' : 'saving');
  let segType = seg;
  let savingDir = data.type === 'withdrawal' ? 'withdrawal' : 'saving';

  const catOpts = (type) => {
    const kinds = type === 'income' ? ['income'] : ['fixed', 'variable'];
    return state.cats.filter((c) => kinds.includes(c.kind));
  };

  sheet({
    title: editing ? 'Editar movimiento' : 'Nuevo movimiento',
    body: html`
      <div class="finForm">
        <div class="finSeg" data-seg="type">
          <button type="button" data-v="expense" aria-pressed="${segType === 'expense'}">Gasto</button>
          <button type="button" data-v="income" aria-pressed="${segType === 'income'}">Ingreso</button>
          <button type="button" data-v="saving" aria-pressed="${segType === 'saving'}">Ahorro</button>
        </div>
        <div class="finSeg finSeg--sub" data-seg="dir" ${segType === 'saving' ? '' : 'hidden'}>
          <button type="button" data-v="saving" aria-pressed="${savingDir === 'saving'}">→ Ingresar a la meta</button>
          <button type="button" data-v="withdrawal" aria-pressed="${savingDir === 'withdrawal'}">← Retirar de la meta</button>
        </div>
        ${raw(field('Monto', `<input type="text" inputmode="numeric" autocomplete="off" data-f="amount" value="${formatCOPInput(data.amount)}" placeholder="$0">`))}
        ${raw(field('Fecha', `<input type="date" data-f="date" value="${data.date}">`))}
        <div data-block="goal" ${segType === 'saving' ? '' : 'hidden'}>
          ${raw(field('Meta de ahorro', `<select data-f="goal_id">${
  optionList(state.goals, data.goal_id, (g) => ({ value: g.id, label: `🎯 ${g.name} · ${money(g.current)} / ${money(g.target)}` }))}</select>`))}
        </div>
        <div data-block="cats" ${segType === 'saving' ? 'hidden' : ''}>
          <div class="finFieldRow">
            ${raw(field('Categoría', `<select data-f="category_id"><option value="">— elige —</option>${
  optionList(catOpts(data.type), data.category_id, (c) => ({ value: c.id, label: `${c.emoji || ''} ${c.name}` }))}</select>`))}
            <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act-local="cat-edit" aria-label="Modificar categoría">✎</button>
          </div>
          <div class="finFieldRow" style="margin-top:14px">
            ${raw(field('Subcategoría', '<select data-f="subcategory_id"><option value="">— elige —</option></select>'))}
            <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act-local="sub-edit" aria-label="Modificar subcategoría">✎</button>
          </div>
        </div>
        ${raw(field(segType === 'saving' && savingDir === 'withdrawal' ? 'Motivo' : 'Descripción', `<input type="text" data-f="description" list="txDescList" autocomplete="off" value="${esc(data.description)}" placeholder="Opcional">`))}
        ${raw(`<datalist id="txDescList">${descHistory().map((d) => `<option value="${esc(d)}">`).join('')}</datalist>`)}
        <div data-block="reimb" ${segType === 'expense' ? '' : 'hidden'}>
          <label class="finCheckbox">
            <input type="checkbox" data-f="reimbursable" ${data.reimbursable ? 'checked' : ''}>
            <span>Reembolsable · el dinero vuelve, no consume tu presupuesto</span>
          </label>
          <div data-block="payer" style="margin-top:12px" ${data.reimbursable ? '' : 'hidden'}>
            ${raw(field('¿Quién reembolsa?', `<input type="text" data-f="reimburse_by" list="txPayerList" autocomplete="off" value="${esc(data.reimburse_by)}" placeholder="Dead Camera">`))}
            ${raw(`<datalist id="txPayerList">${payerHistory().map((d) => `<option value="${esc(d)}">`).join('')}</datalist>`)}
            ${tx?.reimbursed_at ? H`<p class="finNote" style="margin-top:8px">✓ Conciliado el ${tx.reimbursed_at.slice(0, 10)}.
              <button class="finLink" type="button" data-act-local="unreconcile">Volver a pendiente</button></p>` : ''}
          </div>
        </div>
      </div>`,
    onOpen: ({ root: r, close }) => {
      const get = (f) => $(`[data-f="${f}"]`, r);
      const block = (k) => $(`[data-block="${k}"]`, r);
      let unreconcile = false;
      bindCOPInput(get('amount'));

      const paintSubs = () => {
        const sel = get('subcategory_id');
        const list = state.subs.filter((s) => s.category_id === get('category_id').value);
        sel.innerHTML = '<option value="">— elige —</option>'
          + optionList(list, data.subcategory_id, (s) => ({ value: s.id, label: `${s.emoji || ''} ${s.name}` }));
      };
      const paintCats = () => {
        const sel = get('category_id');
        sel.innerHTML = '<option value="">— elige —</option>'
          + optionList(catOpts(data.type), data.category_id, (c) => ({ value: c.id, label: `${c.emoji || ''} ${c.name}` }));
        paintSubs();
      };
      const syncBlocks = () => {
        const saving = segType === 'saving';
        $('[data-seg="dir"]', r).hidden = !saving;
        block('goal').hidden = !saving;
        block('cats').hidden = saving;
        block('reimb').hidden = segType !== 'expense';
        block('payer').hidden = !get('reimbursable').checked;
        $('label', get('description').closest('.finField')).textContent = saving && savingDir === 'withdrawal' ? 'Motivo' : 'Descripción';
      };
      paintSubs();

      $$('[data-seg="type"] button', r).forEach((btn) => btn.addEventListener('click', () => {
        segType = btn.dataset.v;
        data.type = segType === 'saving' ? savingDir : segType;
        $$('[data-seg="type"] button', r).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        data.category_id = ''; data.subcategory_id = '';
        paintCats();
        syncBlocks();
      }));
      $$('[data-seg="dir"] button', r).forEach((btn) => btn.addEventListener('click', () => {
        savingDir = btn.dataset.v;
        data.type = savingDir;
        $$('[data-seg="dir"] button', r).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        syncBlocks();
      }));
      get('category_id').addEventListener('change', () => { data.subcategory_id = ''; paintSubs(); });
      get('reimbursable').addEventListener('change', syncBlocks);

      // Al repetir una descripción conocida se rellena lo demás como la última vez.
      get('description').addEventListener('change', () => {
        if (segType !== 'expense') return;
        const key = norm(get('description').value);
        if (!key) return;
        const prev = state.tx.find((t) => isExpense(t) && norm(t.description) === key);
        if (!prev) return;
        if (!get('category_id').value && prev.category_id) {
          data.category_id = prev.category_id; data.subcategory_id = prev.subcategory_id || '';
          paintCats();
        }
        if (prev.reimbursable && !editing) {
          get('reimbursable').checked = true;
          get('reimburse_by').value = prev.reimburse_by || '';
          syncBlocks();
        }
      });

      $('[data-act-local="cat-edit"]', r).addEventListener('click', () => {
        const cat = catById(get('category_id').value);
        if (!cat) return toast('Elige una categoría primero', 'err');
        categorySheet(cat, null, () => { data.category_id = cat.id; paintCats(); });
      });
      $('[data-act-local="sub-edit"]', r).addEventListener('click', () => {
        const sub = subById(get('subcategory_id').value);
        const catId = get('category_id').value;
        if (!sub) return toast('Elige una subcategoría primero', 'err');
        subSheet(catId, sub, () => { data.subcategory_id = sub.id; paintSubs(); });
      });
      $('[data-act-local="unreconcile"]', r)?.addEventListener('click', (e) => {
        unreconcile = true;
        e.target.replaceWith('Se marcará como pendiente al guardar.');
      });

      r.__save = async () => {
        const type = segType === 'saving' ? savingDir : segType;
        const saving = type === 'saving' || type === 'withdrawal';
        const categoryId = saving ? null : (get('category_id').value || null);
        const subId = saving ? null : (get('subcategory_id').value || null);
        const reimbursable = type === 'expense' && get('reimbursable').checked;
        const payload = {
          profile_id: state.profileId,
          type,
          amount: parseCOP(get('amount').value),
          transaction_date: get('date').value || todayISO(),
          category_id: categoryId,
          subcategory_id: subId,
          goal_id: saving ? (get('goal_id').value || null) : null,
          spend_type: spendTypeFor(type, categoryId, subId),
          description: get('description').value.trim(),
          reimbursable,
          reimburse_by: reimbursable ? get('reimburse_by').value.trim() : '',
        };
        if (!reimbursable || unreconcile) { payload.reimbursed_at = null; payload.reimbursement_id = null; }
        if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
          toast('Escribe un monto válido mayor que cero', 'err'); return;
        }
        if (saving && !payload.goal_id) { toast('Crea una meta de ahorro primero', 'err'); return; }
        // El momento del movimiento se fija al crearlo y no se toca al editar,
        // para no reescribir la hora real de algo registrado antes.
        if (!editing) payload.occurred_at = new Date().toISOString();
        try {
          if (editing) {
            await Finance.updateTransaction(tx.id, payload);
            // La meta se ajusta por diferencia: primero se deshace lo viejo, luego se aplica lo nuevo.
            if (goalDelta(tx) || goalDelta(payload)) {
              await applyGoal(tx.goal_id, -goalDelta(tx));
              await applyGoal(payload.goal_id, goalDelta(payload));
            }
          } else {
            await Finance.addTransaction(payload);
            await applyGoal(payload.goal_id, goalDelta(payload));
          }
          close();
          await loadAll({ silent: true });
          toast(editing ? 'Movimiento actualizado' : (saving ? 'Ahorro registrado' : 'Movimiento guardado'));
        } catch { toast('No se pudo guardar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Guardar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

/** Ingresar o retirar dinero de una meta desde la pestaña Ahorros. */
function goalMoveSheet(goal, dir) {
  const deposit = dir === 'saving';
  sheet({
    title: deposit ? `Ingresar ahorro · ${goal.name}` : `Retirar de ${goal.name}`,
    body: html`
      <div class="finForm">
        <p class="sheetText">${deposit
    ? `Sale del saldo disponible y entra a la meta. Lleva ${money(goal.current)} de ${money(goal.target)}.`
    : `Vuelve al saldo disponible. La meta tiene ${money(goal.current)}.`}</p>
        ${raw(field('Monto', '<input type="text" inputmode="numeric" autocomplete="off" data-f="amount" placeholder="$0">'))}
        ${raw(field('Fecha', `<input type="date" data-f="date" value="${todayISO()}">`))}
        ${raw(field(deposit ? 'Nota (opcional)' : 'Motivo (opcional)', `<input type="text" data-f="description" placeholder="${deposit ? 'Quincena, extra…' : '¿Para qué lo sacas?'}">`))}
      </div>`,
    onOpen: ({ root: r, close }) => {
      const get = (f) => $(`[data-f="${f}"]`, r);
      bindCOPInput(get('amount'));
      r.__save = async () => {
        const amount = parseCOP(get('amount').value);
        if (!Number.isSafeInteger(amount) || amount <= 0) return toast('Escribe un monto válido', 'err');
        if (!deposit && amount > n(goal.current)) return toast('La meta no tiene tanto dinero', 'err');
        const payload = {
          profile_id: state.profileId,
          type: dir,
          amount,
          transaction_date: get('date').value || todayISO(),
          goal_id: goal.id,
          spend_type: 'saving',
          description: get('description').value.trim(),
          occurred_at: new Date().toISOString(),
        };
        try {
          await Finance.addTransaction(payload);
          await applyGoal(goal.id, goalDelta(payload));
          close();
          await loadAll({ silent: true });
          toast(deposit ? 'Ahorro ingresado 🐖' : 'Retiro registrado');
        } catch { toast('No se pudo guardar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: deposit ? 'Ingresar' : 'Retirar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

/** Conciliar reembolsables: se marcan como recibidos y, si se quiere, se crea el ingreso. */
function reconcileSheet() {
  const re = reimbPending();
  if (!re.items.length) return toast('No hay reembolsos pendientes');
  const picked = new Set(re.items.map((t) => t.id));
  const rowHTMLr = (t) => `
    <button class="finCheck finCheck--pick is-done" type="button" data-re="${t.id}">
      <span class="finCheckBox">✓</span>
      <span class="finCheckText"><b>${esc(t.description || 'Gasto')}</b><small>${esc(t.transaction_date)} · ${esc(t.reimburse_by || 'Sin indicar')}</small></span>
      <span class="finCheckAmt">${money(t.amount)}</span>
    </button>`;

  sheet({
    title: 'Conciliar reembolsos',
    body: html`
      <p class="sheetText">Marca lo que ya te devolvieron. Pendiente: <b>${money(re.total)}</b>${re.by.length > 1 ? ' · ' + re.by.map(([k, v]) => `${k} ${money(v)}`).join(', ') : ''}.</p>
      <div class="finChecks">${raw(re.items.map(rowHTMLr).join(''))}</div>
      <div class="finForm" style="margin-top:14px">
        <div class="finReTotal">Seleccionado: <b data-re-total>${money(re.total)}</b></div>
        <label class="finCheckbox">
          <input type="checkbox" data-f="create" checked>
          <span>Crear el ingreso del reembolso automáticamente</span>
        </label>
        ${raw(field('Fecha en que llegó', `<input type="date" data-f="date" value="${todayISO()}">`))}
      </div>`,
    onOpen: ({ root: r, close }) => {
      const get = (f) => $(`[data-f="${f}"]`, r);
      const refresh = () => {
        const total = sumBy(re.items.filter((t) => picked.has(t.id)), amt);
        $('[data-re-total]', r).textContent = money(total);
      };
      $$('[data-re]', r).forEach((btn) => btn.addEventListener('click', () => {
        const id = btn.dataset.re;
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        btn.classList.toggle('is-done', picked.has(id));
        refresh();
      }));
      r.__save = async () => {
        const items = re.items.filter((t) => picked.has(t.id));
        if (!items.length) return toast('Selecciona al menos uno', 'err');
        const when = get('date').value || todayISO();
        const payers = [...new Set(items.map((t) => (t.reimburse_by || '').trim()).filter(Boolean))];
        try {
          let incomeId = null;
          if (get('create').checked) {
            const income = await Finance.addTransaction({
              profile_id: state.profileId,
              type: 'income',
              amount: sumBy(items, amt),
              transaction_date: when,
              category_id: refundCatId(),
              subcategory_id: null,
              spend_type: 'income',
              description: `Reembolso ${payers.join(' + ') || ''}`.trim(),
              occurred_at: new Date().toISOString(),
            });
            incomeId = income?.id || null;
          }
          const stamp = new Date(when + 'T12:00:00').toISOString();
          await Promise.all(items.map((t) => Finance.updateTransaction(t.id, { reimbursed_at: stamp, reimbursement_id: incomeId })));
          close();
          await loadAll({ silent: true });
          toast('Reembolsos conciliados ✓');
        } catch { toast('No se pudo conciliar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Conciliar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

/** Desglose del dinero realmente libre. */
function freeSheet() {
  const fm = freeMoney();
  const line = (label, value, sign = '') => html`
    <div class="finCalcRow ${sign === '−' ? 'is-minus' : sign === '+' ? 'is-plus' : ''}">
      <span>${label}</span><b>${sign}${money(Math.abs(value))}</b>
    </div>`;
  sheet({
    title: 'Dinero realmente libre',
    body: html`
      <div class="finCalc">
        ${raw(line('Saldo disponible', fm.saldo))}
        ${raw(line('Gastos fijos pendientes del mes', fm.fixedPending, '−'))}
        ${raw(line('Presupuesto semanal protegido', fm.protectedBudget, '−'))}
        ${raw(line('Deudas pendientes', fm.debts, '−'))}
        ${raw(line('Reembolsos por recibir', fm.reimb, '+'))}
        <div class="finCalcRow is-total"><span>Dinero realmente libre</span><b>${money(fm.free)}</b></div>
      </div>
      <p class="finNote">Es lo que puedes usar sin tocar obligaciones, presupuesto de la semana ni lo que falta del mes.
      El presupuesto protegido es lo que te queda esta semana más las semanas que faltan del mes.</p>`,
    actions: [{ label: 'Cerrar', onClick: ({ close }) => close() }],
  });
}

function simpleSheet({ title, note, fields, onSave, onSaved }) {
  sheet({
    title,
    body: html`${note ? H`<p class="sheetText">${note}</p>` : ''}<div class="finForm">${raw(fields.map((f) => {
      if (f.type === 'select') {
        return field(f.label, `<select data-f="${f.key}">${
          optionList(f.options, f.value, (o) => ({ value: o.value, label: o.label }))}</select>`);
      }
      const isMoney = f.type === 'number';
      return field(f.label, `<input type="${isMoney ? 'text' : (f.type || 'text')}" data-f="${f.key}"
        value="${esc(isMoney ? formatCOPInput(f.value) : (f.value ?? ''))}" placeholder="${esc(isMoney ? '$0' : (f.placeholder || ''))}"
        ${isMoney ? 'inputmode="numeric" autocomplete="off" data-money' : ''}>`);
    }).join(''))}</div>`,
    onOpen: ({ root: r, close }) => {
      $$('[data-money]', r).forEach(bindCOPInput);
      r.__save = async () => {
        const values = {};
        fields.forEach((f) => {
          const value = $(`[data-f="${f.key}"]`, r).value;
          values[f.key] = f.type === 'number' ? String(parseCOP(value)) : value;
        });
        try {
          await onSave(values);
          close();
          await loadAll({ silent: true });
          toast('Guardado');
          onSaved?.();
        } catch { toast('No se pudo guardar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Guardar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

function categorySheet(cat, kindHint, onSaved) {
  const kind = cat?.kind || kindHint || 'variable';
  return simpleSheet({
    title: cat ? 'Editar categoría' : 'Nueva categoría',
    fields: [
      { key: 'emoji', label: 'Emoji', value: cat?.emoji || '📦' },
      { key: 'name', label: 'Nombre', value: cat?.name || '' },
    ],
    onSave: (v) => {
      const payload = { name: v.name.trim(), emoji: v.emoji.trim() || '📦', kind };
      if (cat) return Finance.updateCategory(cat.id, payload);
      return Finance.addCategory({ ...payload, slug: norm(v.name).replace(/\s+/g, '-') });
    },
    onSaved,
  });
}

function subSheet(catId, sub, onSaved) {
  return simpleSheet({
    title: sub ? 'Editar subcategoría' : 'Nueva subcategoría',
    fields: [
      { key: 'emoji', label: 'Emoji', value: sub?.emoji || '•' },
      { key: 'name', label: 'Nombre', value: sub?.name || '' },
    ],
    onSave: (v) => {
      const payload = { name: v.name.trim(), emoji: v.emoji.trim() || '•' };
      return sub ? Finance.updateSub(sub.id, payload) : Finance.addSub({ ...payload, category_id: catId });
    },
    onSaved,
  });
}

/** Formulario compartido por gastos fijos, ahorro planeado y categorías semanales. */
function budgetSheet(b, { period = b?.period || 'month', kind = b?.kind || 'fixed' } = {}) {
  const weekly = period === 'week';
  const data = {
    name: b?.name || '',
    category_id: b?.category_id || '',
    subcategory_id: b?.subcategory_id || '',
    kind: weekly ? 'variable' : kind,
    amount: b ? n(b.amount) : '',
    group_key: b?.group_key || 'need',
  };
  const catOpts = () => state.cats.filter((c) => c.kind === 'fixed' || c.kind === 'variable');
  const titles = {
    week: b ? 'Editar categoría semanal' : 'Nueva categoría semanal',
    fixed: b ? 'Editar gasto fijo' : 'Nuevo gasto fijo',
    saving: b ? 'Editar ahorro planeado' : 'Nuevo ahorro planeado',
  };

  sheet({
    title: titles[weekly ? 'week' : data.kind] || 'Presupuesto',
    body: html`
      <div class="finForm">
        ${raw(field('Nombre', `<input type="text" data-f="name" value="${esc(data.name)}" placeholder="${weekly ? 'Mercado, Gasolina…' : 'Arriendo, Spotify…'}">`))}
        ${raw(field(weekly ? 'Presupuesto semanal' : 'Monto del mes', `<input type="text" inputmode="numeric" autocomplete="off" data-f="amount" data-money value="${formatCOPInput(data.amount)}" placeholder="$0">`))}
        ${weekly ? raw(field('Grupo', `<select data-f="group_key">
          <option value="need" ${data.group_key === 'need' ? 'selected' : ''}>Necesidades</option>
          <option value="life" ${data.group_key === 'life' ? 'selected' : ''}>Vida / disfrute</option>
        </select>`)) : ''}
        ${raw(field('Categoría', `<select data-f="category_id"><option value="">— elige —</option>${
  optionList(catOpts(), data.category_id, (c) => ({ value: c.id, label: `${c.emoji || ''} ${c.name}` }))}</select>`))}
        ${raw(field('Subcategoría (opcional)', '<select data-f="subcategory_id"><option value="">— toda la categoría —</option></select>'))}
        <p class="finNote" style="margin:0">${weekly
    ? 'Con subcategoría, solo cuentan esos gastos. Sin ella, cuenta toda la categoría salvo lo que ya tenga su propia línea.'
    : 'La subcategoría sirve para detectar sola cuándo ya pagaste este fijo en el mes.'}</p>
      </div>`,
    onOpen: ({ root: r, close }) => {
      const get = (f) => $(`[data-f="${f}"]`, r);
      bindCOPInput(get('amount'));
      const paintSubs = () => {
        const list = state.subs.filter((s) => s.category_id === get('category_id').value);
        get('subcategory_id').innerHTML = '<option value="">— toda la categoría —</option>'
          + optionList(list, data.subcategory_id, (s) => ({ value: s.id, label: `${s.emoji || ''} ${s.name}` }));
      };
      paintSubs();
      get('category_id').addEventListener('change', () => { data.subcategory_id = ''; paintSubs(); });
      r.__save = async () => {
        const catId = get('category_id').value || null;
        if (weekly && !catId) return toast('Elige una categoría', 'err');
        const amount = parseCOP(get('amount').value);
        if (!Number.isFinite(amount) || amount < 0) return toast('Escribe un monto válido', 'err');
        const name = get('name').value.trim() || catById(catId)?.name || '';
        if (!name) return toast('Escribe un nombre', 'err');
        const payload = {
          profile_id: state.profileId,
          category_id: catId,
          subcategory_id: get('subcategory_id').value || null,
          name,
          kind: data.kind,
          amount,
          period,
          is_weekly: weekly,
          group_key: weekly ? get('group_key').value : '',
        };
        try {
          if (b) await Finance.updateBudget(b.id, payload);
          else await Finance.addBudget(payload);
          close();
          await loadAll({ silent: true });
          toast(b ? 'Presupuesto actualizado' : 'Presupuesto guardado');
        } catch { toast('No se pudo guardar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Guardar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

/* ============================ eventos ============================ */
function shiftMonth(delta) {
  let m = state.month + delta;
  let y = state.year;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  state.month = m; state.year = y;
  paint();
  loadAll({ silent: true });
}

function wire() {
  if (root.dataset.finWired) return;
  root.dataset.finWired = '1';

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; paint(); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const p = profile();

    if (act === 'prev') return shiftMonth(-1);
    if (act === 'next') return shiftMonth(1);
    if (act === 'tools') return accionMenu('pdf');
    if (act === 'wk-prev') { state.weekOffset -= 1; return paint(); }
    if (act === 'wk-next') { state.weekOffset += 1; return paint(); }
    if (act === 'free-detail') return freeSheet();
    if (act === 'reconcile') return reconcileSheet();

    if (act === 'base') {
      return simpleSheet({
        title: 'Ingreso esperado del mes',
        note: 'Tu sueldo u otros ingresos fijos. Sirve para la proyección: los gastos fijos nunca se muestran como dinero libre.',
        fields: [{ key: 'base_income', label: 'Ingreso base', type: 'number', value: n(p?.base_income) }],
        onSave: (v) => Finance.updateProfile(state.profileId, { base_income: n(v.base_income) }),
      });
    }
    if (act === 'opening') {
      return simpleSheet({
        title: 'Saldo inicial',
        note: `El saldo disponible se calcula sumando todos tus movimientos a este saldo inicial. Hoy marca ${money(saldo())}: ajusta el inicial para que coincida con tu cuenta.`,
        fields: [{ key: 'opening_balance', label: 'Saldo inicial', type: 'number', value: n(p?.opening_balance) }],
        onSave: (v) => Finance.updateProfile(state.profileId, { opening_balance: n(v.opening_balance) }),
      });
    }

    /* --- movimientos --- */
    if (act === 'tx-new') return txSheet(null);
    if (act === 'tx-edit' || act === 'tx-del') {
      const id = btn.closest('[data-tx]').dataset.tx;
      const tx = state.tx.find((t) => t.id === id);
      if (act === 'tx-edit') return txSheet(tx);
      return confirmSheet('Eliminar movimiento', '¿Borrar este movimiento? No se puede deshacer.', async () => {
        try {
          await Finance.removeTransaction(id);
          await applyGoal(tx?.goal_id, -goalDelta(tx || {}));
          await loadAll({ silent: true });
          toast('Movimiento eliminado');
        } catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- presupuesto --- */
    if (act === 'bud-new') return budgetSheet(null, { period: 'month', kind: btn.dataset.kind || 'fixed' });
    if (act === 'wk-new') return budgetSheet(null, { period: 'week' });
    if (act === 'bud-edit' || act === 'wk-edit') {
      const id = btn.closest('[data-budget]')?.dataset.budget;
      const b = state.budgets.find((x) => x.id === id);
      return budgetSheet(b);
    }
    if (act === 'bud-del') {
      const id = btn.closest('[data-budget]').dataset.budget;
      return confirmSheet('Eliminar del plan', '¿Quitar esta línea del presupuesto? Los movimientos no se tocan.', async () => {
        try { await Finance.removeBudget(id); await loadAll({ silent: true }); toast('Línea eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- metas --- */
    if (act === 'goal-in' || act === 'goal-out') {
      const id = btn.closest('[data-goal]').dataset.goal;
      const g = goalById(id);
      return g && goalMoveSheet(g, act === 'goal-in' ? 'saving' : 'withdrawal');
    }
    if (act === 'goal-new' || act === 'goal-edit' || act === 'goal-img') {
      const id = btn.closest('[data-goal]')?.dataset.goal;
      const g = goalById(id);
      return simpleSheet({
        title: g ? 'Editar meta' : 'Nueva meta',
        fields: [
          { key: 'name', label: 'Nombre', value: g?.name || '', placeholder: 'Parapente, Fondo 6 meses…' },
          { key: 'target', label: 'Monto objetivo', type: 'number', value: g ? n(g.target) : '' },
          { key: 'current', label: 'Ahorrado hasta hoy', type: 'number', value: g ? n(g.current) : 0 },
          { key: 'target_date', label: 'Fecha objetivo', type: 'date', value: g?.target_date || '' },
          { key: 'image_url', label: 'Imagen (enlace)', value: g?.image_url || '', placeholder: 'https://…' },
        ],
        onSave: (v) => {
          const payload = {
            profile_id: state.profileId,
            name: v.name.trim(),
            target: n(v.target),
            current: n(v.current),
            target_date: v.target_date || null,
            image_url: v.image_url.trim() || null,
          };
          return g ? Finance.updateGoal(g.id, payload) : Finance.addGoal(payload);
        },
      });
    }
    if (act === 'goal-del') {
      const id = btn.closest('[data-goal]').dataset.goal;
      return confirmSheet('Eliminar meta', '¿Borrar esta meta de ahorro? Los movimientos de ahorro quedan en el historial.', async () => {
        try { await Finance.removeGoal(id); await loadAll({ silent: true }); toast('Meta eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- categorías --- */
    if (act === 'cat-new' || act === 'cat-edit') {
      const id = btn.closest('[data-cat]')?.dataset.cat;
      const c = state.cats.find((x) => x.id === id);
      return categorySheet(c, btn.dataset.kind);
    }
    if (act === 'cat-del') {
      const id = btn.closest('[data-cat]').dataset.cat;
      return confirmSheet('Eliminar categoría', 'Se borra la categoría y sus subcategorías. Los movimientos que la tenían asignada quedan sin categoría.', async () => {
        try { await Finance.removeCategory(id); await loadAll({ silent: true }); toast('Categoría eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }
    if (act === 'sub-new' || act === 'sub-edit') {
      const catId = btn.closest('[data-cat]').dataset.cat;
      const id = btn.closest('[data-sub]')?.dataset.sub;
      const s = state.subs.find((x) => x.id === id);
      return subSheet(catId, s);
    }
    if (act === 'sub-del') {
      const id = btn.closest('[data-sub]').dataset.sub;
      return confirmSheet('Eliminar subcategoría', '¿Borrarla del mapa de gastos?', async () => {
        try { await Finance.removeSub(id); await loadAll({ silent: true }); toast('Subcategoría eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- deudas --- */
    if (act === 'debt-new' || act === 'debt-edit') {
      const id = btn.closest('[data-debt]')?.dataset.debt;
      const d = state.debts.find((x) => x.id === id);
      return simpleSheet({
        title: d ? 'Editar deuda' : 'Nueva deuda',
        fields: [
          { key: 'person', label: 'Persona o entidad', value: d?.person || '' },
          { key: 'concept', label: 'Concepto', value: d?.concept || '' },
          { key: 'amount', label: 'Monto', type: 'number', value: d ? n(d.amount) : '' },
          { key: 'due_date', label: 'Próximo pago / vence', type: 'date', value: d?.due_date || '' },
        ],
        onSave: (v) => {
          const payload = {
            profile_id: state.profileId,
            person: v.person.trim(),
            concept: v.concept.trim(),
            amount: n(v.amount),
            due_date: v.due_date || null,
          };
          if (d) return Finance.updateDebt(d.id, payload);
          return Finance.addDebt({ ...payload, created_date: todayISO(), status: 'pending' });
        },
      });
    }
    if (act === 'debt-toggle') {
      const id = btn.closest('[data-debt]').dataset.debt;
      const d = state.debts.find((x) => x.id === id);
      const paid = d.status === 'paid';
      try {
        await Finance.updateDebt(id, { status: paid ? 'pending' : 'paid', paid_at: paid ? null : new Date().toISOString() });
        await loadAll({ silent: true });
        toast(paid ? 'Marcada como pendiente' : 'Deuda pagada y archivada ✓');
      } catch { toast('No se pudo actualizar', 'err'); }
      return;
    }
    if (act === 'debt-del') {
      const id = btn.closest('[data-debt]').dataset.debt;
      return confirmSheet('Eliminar deuda', '¿Borrar esta obligación del historial?', async () => {
        try { await Finance.removeDebt(id); await loadAll({ silent: true }); toast('Deuda eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }
  });
}

/* ============================ ciclo de vida ============================ */
export async function render(container) {
  root = container;
  document.body.dataset.skin = 'finanzas';
  state.profileId = perfilActivo()?.id || 'alejo';

  const today = todayISO();
  state.year = Number(today.slice(0, 4));
  state.month = Number(today.slice(5, 7));
  state.tab = 'movimientos';
  state.weekOffset = 0;

  hydrate();
  aplicarAcento(profile());
  paint();
  wire();

  try { await loadAll({ silent: true }); }
  catch { if (!state.loaded) toast('Sin conexión: mostrando lo último guardado', 'err'); }

  watch('finance', ['finance_transactions', 'budgets', 'savings_goals', 'debts',
    'finance_categories', 'finance_subcategories', 'profiles'],
  () => loadAll({ silent: true }));
}

export function destroy() {
  unwatch('finance');
  limpiarAcento();
  document.getElementById('printArea')?.remove();
  document.body.classList.remove('is-printing');
  delete document.body.dataset.skin;
  root = null;
}
