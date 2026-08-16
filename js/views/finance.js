// AS HUB — AS FINANZAS (recreación del original)
import { Finance, Checks, watch, unwatch, readCache, writeCache } from '../db.js';
import {
  $, $$, html, raw, esc, money, num, toast, sheet, confirmSheet,
  todayISO, addDays, monthRange, pct,
} from '../ui.js';
import { TZ, ACCENTS, APP_VERSION } from '../config.js';
import { perfilActivo } from '../session.js';
import { bindCOPInput, formatCOPInput, parseCOP } from '../cop-input.js';

/* ============================ constantes ============================ */
const TABS = [
  { id: 'movimientos', label: 'Movimientos' },
  { id: 'checklist', label: 'Check List' },
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

// el original convierte el presupuesto mensual a semanal dividiendo por 4,33
const WEEKS_PER_MONTH = 4.33;

const SLICE_COLORS = ['#e8348f', '#4a7fe0', '#a8e050', '#ffb347', '#7b5fe0',
  '#26c6a0', '#ff6b6b', '#8bd8ff', '#d5b8ff', '#b0b0a8'];

/* ============================ estado ============================ */
let root;
let state = {
  tab: 'movimientos',
  profileId: '',
  year: 0, month: 0,
  period: 'month',
  profiles: [], cats: [], subs: [], tx: [], budgets: [], goals: [], debts: [],
  checks: [],
  loaded: false,
};

/* ============================ utilidades ============================ */
// fragmento anidado: ya viene escapado por html(), no se debe volver a escapar
const H = (strings, ...values) => raw(html(strings, ...values));

const n = (v) => Number(v) || 0;
const dateAt = (iso) => new Date(iso + 'T12:00:00');
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

/** Domingo de la semana que contiene la fecha dada. */
function weekStart(iso) {
  const d = dateAt(iso);
  return addDays(iso, -d.getDay());
}

/** Cada mes tiene su propia lista; las marcas de meses anteriores quedan como historial. */
const periodoClave = () => `${state.year}-${String(state.month).padStart(2, '0')}`;

const profile = () => state.profiles.find((p) => p.id === state.profileId) || state.profiles[0] || null;
const catById = (id) => state.cats.find((c) => c.id === id) || null;
const subById = (id) => state.subs.find((s) => s.id === id) || null;

function range() {
  return monthRange(state.year, state.month);
}

function monthTx() {
  const { from, to } = range();
  return state.tx.filter((t) => t.transaction_date >= from && t.transaction_date <= to);
}

/** Movimientos del periodo elegido en Estadísticas. */
function periodTx() {
  if (state.period === 'all') return state.tx;
  if (state.period === 'q') {
    const { to } = range();
    const start = monthRange(
      state.month <= 2 ? state.year - 1 : state.year,
      ((state.month - 3 + 12 - 1) % 12) + 1,
    ).from;
    return state.tx.filter((t) => t.transaction_date >= start && t.transaction_date <= to);
  }
  return monthTx();
}

const sumBy = (list, f) => list.reduce((acc, x) => acc + n(f(x)), 0);

function totals(list) {
  const income = sumBy(list.filter((t) => t.type === 'income'), (t) => t.amount);
  const expense = sumBy(list.filter((t) => t.type === 'expense'), (t) => t.amount);
  return { income, expense, balance: income - expense };
}

/* ============================ carga ============================ */
async function loadAll({ silent = false } = {}) {
  const pid = state.profileId;
  const mes = `${state.year}-${String(state.month).padStart(2, '0')}`;
  const [profiles, cats, subs, tx, budgets, goals, debts, checks] = await Promise.all([
    Finance.profiles(), Finance.categories(), Finance.subcategories(),
    Finance.allTransactions(pid), Finance.budgets(pid), Finance.goals(pid), Finance.debts(pid),
    Checks.list(pid, mes),
  ]);
  Object.assign(state, { profiles, cats, subs, tx, budgets, goals, debts, checks, loaded: true });
  writeCache('fin:' + pid, { profiles, cats, subs, tx, budgets, goals, debts, checks });
  aplicarAcento(profiles.find((x) => x.id === pid));
  if (!silent) toast('Finanzas al día');
  paint();
}

function hydrate() {
  const c = readCache('fin:' + state.profileId);
  if (c) Object.assign(state, c, { loaded: true });
}

/* ============================ piezas ============================ */
function statsHTML() {
  const p = profile();
  const t = totals(monthTx());
  return html`
    <div class="finStats">
      <div class="finStat">
        <span>Ingreso base <button type="button" data-act="base" aria-label="Editar ingreso base">✎</button></span>
        <b>${money(p?.base_income)}</b>
      </div>
      <div class="finStat finStat--in"><span>Ingresos registrados</span><b>${money(t.income)}</b></div>
      <div class="finStat finStat--out"><span>Gastos registrados</span><b>${money(t.expense)}</b></div>
      <div class="finStat finStat--bal"><span>Balance actual</span><b>${money(t.balance)}</b></div>
    </div>`;
}

function rowHTML(t) {
  const cat = catById(t.category_id);
  const sub = subById(t.subcategory_id);
  const income = t.type === 'income';
  const title = t.description || sub?.name || cat?.name || 'Movimiento';
  // Sin hora conocida (movimientos históricos importados) no se muestra nada.
  const meta = [cat?.name, sub?.name, timeOf(t.occurred_at)].filter(Boolean).join(' · ');
  return html`
    <div class="finRow ${income ? 'finRow--in' : 'finRow--out'}" data-tx="${t.id}">
      <div class="finRowIcon">${sub?.emoji || cat?.emoji || '💸'}</div>
      <div class="finRowText"><b>${title}</b><small>${meta}</small></div>
      <div class="finRowAmt">${income ? '+ ' : '− '}${money(t.amount)}</div>
      <div class="finIcons">
        <button type="button" data-act="tx-edit" aria-label="Editar">✎</button>
        <button type="button" data-act="tx-del" aria-label="Eliminar">✕</button>
      </div>
    </div>`;
}

function viewMovimientos() {
  const list = monthTx();
  const expenses = list.filter((t) => t.type === 'expense');
  const fijos = sumBy(expenses.filter((t) => t.spend_type === 'fixed'), (t) => t.amount);
  const variables = sumBy(expenses.filter((t) => t.spend_type !== 'fixed'), (t) => t.amount);
  const hoy = sumBy(expenses.filter((t) => t.transaction_date === todayISO()), (t) => t.amount);

  const days = [...new Set(list.map((t) => t.transaction_date))].sort().reverse();

  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div>
          <span class="finTag">Tu mes en movimiento</span>
          <h2>Movimientos</h2>
        </div>
      </div>

      <div class="finMini">
        <div class="finMiniBox"><span>FIJOS</span><b>${money(fijos)}</b></div>
        <div class="finMiniBox"><span>VARIABLES</span><b>${money(variables)}</b></div>
        <div class="finMiniBox"><span>HOY</span><b>${money(hoy)}</b></div>
      </div>

      ${days.length ? raw(`<div class="finDays">${days.map((iso) => {
    const items = list.filter((t) => t.transaction_date === iso);
    const t = totals(items);
    const d = dateAt(iso);
    return html`
          <section class="finDay">
            <div class="finDayHead">
              <div class="finDayDate">
                <b>${d.getDate()}</b>
                <span>${DIAS_CORTOS[d.getDay()]}<i>${MES_CORTO[d.getMonth()]} de ${d.getFullYear()}</i></span>
              </div>
              <div class="finDaySum">
                <span class="in">${t.income ? '+ ' + money(t.income) : money(0)}</span>
                <span class="out">${t.expense ? '− ' + money(t.expense) : money(0)}</span>
              </div>
            </div>
            ${raw(items.map(rowHTML).join(''))}
          </section>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Sin movimientos en ${MESES[state.month - 1]}. Toca el botón flotante “+” para registrar el primero.</div>`}
    </div>`;
}

function budgetTotals() {
  const by = (k) => sumBy(state.budgets.filter((b) => b.kind === k && b.active !== false), (b) => b.amount);
  const fixed = by('fixed');
  const variable = by('variable');
  const saving = by('saving');
  const debt = sumBy(state.debts.filter((d) => d.status !== 'paid'), (d) => d.amount);
  return { fixed, variable, saving, debt, total: fixed + variable + saving };
}

function weekRhythm() {
  const start = weekStart(todayISO());
  const end = addDays(start, 6);
  const week = state.tx.filter((t) => t.type === 'expense'
    && t.transaction_date >= start && t.transaction_date <= end);

  const items = state.budgets.filter((b) => b.kind === 'variable' && b.active !== false).map((b) => {
    const key = norm(b.name);
    const spent = sumBy(week.filter((t) => {
      const c = catById(t.category_id); const s = subById(t.subcategory_id);
      return norm(c?.name) === key || norm(s?.name) === key;
    }), (t) => t.amount);
    const weekly = Math.round(n(b.amount) / WEEKS_PER_MONTH);
    return { name: b.name, spent, weekly, over: spent > weekly };
  });
  return { start, end, items };
}

function viewPresupuesto() {
  const p = profile();
  const b = budgetTotals();
  const free = n(p?.base_income) - b.total;
  const rhythm = weekRhythm();
  const pendientes = state.debts.filter((d) => d.status !== 'paid');

  const lines = (kind) => state.budgets.filter((x) => x.kind === kind && x.active !== false);
  const lineGroup = (kind) => (lines(kind).length ? html`
      <p class="finGroupTitle">${KINDS[kind].label}</p>
      ${raw(lines(kind).map((x) => html`
        <div class="finLine" data-budget="${x.id}">
          <span>${KINDS[kind].line} ${x.name}</span>
          <b>${money(x.amount)}</b>
          <span class="finIcons" style="flex:none">
            <button type="button" data-act="bud-edit" aria-label="Editar">✎</button>
            <button type="button" data-act="bud-del" aria-label="Eliminar">✕</button>
          </span>
        </div>`).join(''))}` : '');

  return html`
    <div class="finTwo">
      <div class="finPanel">
        <div class="finPanelHead">
          <div><span class="finTag">Plan del mes</span><h2>Presupuesto dividido</h2></div>
          <button class="finBtn" type="button" data-act="bud-new">+ Obligación</button>
        </div>

        <div class="finBudgetGrid">
          <div class="finBox finBox--fix"><span>📌 Mínimo necesario</span><b>${money(b.fixed)}</b><small>Suma de todos tus gastos fijos</small></div>
          <div class="finBox finBox--var"><span>🎲 Mínimo variable</span><b>${money(b.variable)}</b><small>Suma de tus variables presupuestados</small></div>
          <div class="finBox finBox--sav"><span>🐖 Ahorro planeado</span><b>${money(b.saving)}</b><small>Apartado obligatorio del mes</small></div>
          <div class="finBox finBox--debt"><span>💳 Deudas pendientes</span><b>${money(b.debt)}</b><small>Obligaciones por organizar; no son gastos realizados</small></div>
          <div class="finBox finBox--total"><span>Total comprometido</span><b>${money(b.total)}</b><small>Libre después del plan: ${money(free)}</small></div>
        </div>

        <details class="finDetails">
          <summary>▸ Ver ${num(pendientes.length)} ${pendientes.length === 1 ? 'deuda pendiente' : 'deudas pendientes'}</summary>
          <div>${pendientes.length ? raw(pendientes.map((d) => html`
            <div class="finLine"><span>💳 ${d.person}${d.concept ? ' · ' + d.concept : ''}</span><b>${money(d.amount)}</b></div>`).join(''))
    : H`<p class="finEmpty" style="padding:16px">Sin deudas pendientes.</p>`}</div>
        </details>

        <div class="finLines">
          ${raw(lineGroup('fixed'))}${raw(lineGroup('variable'))}${raw(lineGroup('saving'))}
          ${state.budgets.length ? '' : H`<div class="finEmpty">Aún no hay obligaciones en el plan.</div>`}
        </div>
      </div>

      <div class="finPanel">
        <div class="finPanelHead">
          <div>
            <span class="finTag finTag--lime">Ritmo semanal</span>
            <h2>Presupuesto semanal</h2>
            <p>Semana actual · ${fmtLongDay(rhythm.start)} — ${fmtLongDay(rhythm.end)}</p>
          </div>
        </div>
        ${rhythm.items.length ? raw(`<div class="finWeek">${rhythm.items.map((it) => {
    const p2 = it.weekly ? Math.round((it.spent / it.weekly) * 100) : 0;
    return html`
            <div class="finWeekItem">
              <b>${it.name}<i style="color:${it.over ? 'var(--fn-red)' : 'inherit'}">${money(it.spent)} / ${money(it.weekly)}</i></b>
              <small>Coincidencia por nombre</small>
              <div class="finBar ${it.over ? 'is-over' : ''}"><i style="width:${Math.min(100, p2)}%"></i></div>
              <div class="finWeekFoot">
                <span>${num(p2)}% gastado</span>
                ${it.over
    ? H`<span class="over">Excedido ${money(it.spent - it.weekly)}</span>`
    : H`<span>Quedan ${money(it.weekly - it.spent)}</span>`}
              </div>
            </div>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Agrega obligaciones variables para ver tu ritmo semanal.</div>`}
      </div>
    </div>`;
}

function viewAhorros() {
  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div><span class="finTag">Paso a paso</span><h2>Metas de ahorro</h2></div>
        <button class="finBtn" type="button" data-act="goal-new">+ Nueva meta</button>
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
            <p class="finGoalNums">${money(g.current)} de ${money(g.target)}</p>
            ${g.target_date ? H`<p class="finGoalDate">Fecha objetivo: ${g.target_date}</p>` : ''}
            <div class="finGoalActions">
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-edit">Editar</button>
              <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="goal-del">Eliminar</button>
            </div>
          </div>
        </article>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Todavía no tienes metas. Crea la primera con “+ Nueva meta”.</div>`}
    </div>`;
}

function viewCategorias() {
  const section = (kind) => {
    const cats = state.cats.filter((c) => c.kind === kind);
    return html`
      <section class="finCatSection">
        <div class="finCatHead">
          <h3>${KINDS[kind].emoji} ${KINDS[kind].label}</h3>
          <button class="finBtn finBtn--sm" type="button" data-act="cat-new" data-kind="${kind}">+ Categoría</button>
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
      ${raw(section('fixed'))}${raw(section('variable'))}${raw(section('income'))}
    </div>`;
}

function viewDeudas() {
  const pendientes = state.debts.filter((d) => d.status !== 'paid');
  const total = sumBy(pendientes, (d) => d.amount);
  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div><span class="finTag finTag--lime">Obligaciones pendientes</span><h2>Deudas</h2></div>
        <button class="finBtn" type="button" data-act="debt-new">+ Nueva deuda</button>
      </div>

      <div class="finDebtTotal"><span>Pendiente por pagar</span><b>${money(total)}</b></div>

      ${state.debts.length ? raw(`<div class="finDebts">${state.debts.map((d) => {
    const paid = d.status === 'paid';
    return html`
        <article class="finDebt ${paid ? 'is-paid' : ''}" data-debt="${d.id}">
          <div class="finDebtTop">
            <span class="finDebtState">${paid ? '✓ PAGADA' : '⏳ PENDIENTE'}</span>
            <span class="finDebtAmt">${money(d.amount)}</span>
          </div>
          <b>${d.person}</b>
          <p>${d.concept || 'Sin concepto'}</p>
          <small>Creada ${d.created_date || '—'}${d.due_date ? ' · vence ' + d.due_date : ''}</small>
          <div class="finDebtActions">
            <button class="finBtn finBtn--sm" type="button" data-act="debt-toggle">${paid ? 'Marcar pendiente' : 'Marcar pagada'}</button>
            <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="debt-edit">Editar</button>
            <button class="finBtn finBtn--sm finBtn--plain" type="button" data-act="debt-del">Eliminar</button>
          </div>
        </article>`;
  }).join('')}</div>`) : H`<div class="finEmpty">Sin deudas registradas. 🎉</div>`}
    </div>`;
}

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

function breakdown(list, type) {
  const map = new Map();
  list.filter((t) => t.type === type).forEach((t) => {
    const c = catById(t.category_id);
    const key = c?.id || 'sin';
    const prev = map.get(key) || { name: c?.name || 'Sin categoría', emoji: c?.emoji || '📦', value: 0 };
    prev.value += n(t.amount);
    map.set(key, prev);
  });
  return [...map.values()].sort((a, b) => b.value - a.value);
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

function viewEstadisticas() {
  const list = periodTx();
  const t = totals(list);
  const gastos = breakdown(list, 'expense');
  const ingresos = breakdown(list, 'income');
  const label = state.period === 'all' ? 'Todo el historial'
    : state.period === 'q' ? 'Últimos 3 meses'
      : `${MESES[state.month - 1]} de ${state.year}`;

  return html`
    <div class="finPanel" style="margin-bottom:20px">
      <div class="finPanelHead">
        <div><span class="finTag">Filtro único</span><h2>Estadísticas</h2><p>${label}</p></div>
        <label class="finStatSel">Periodo
          <select data-act="period">
            <option value="month" ${state.period === 'month' ? 'selected' : ''}>Mes seleccionado</option>
            <option value="q" ${state.period === 'q' ? 'selected' : ''}>Últimos 3 meses</option>
            <option value="all" ${state.period === 'all' ? 'selected' : ''}>Todo</option>
          </select>
        </label>
      </div>
      <div class="finTotals">
        <div class="finStat finStat--in"><span>Ingresos</span><b>${money(t.income)}</b></div>
        <div class="finStat finStat--out"><span>Gastos</span><b>${money(t.expense)}</b></div>
        <div class="finStat finStat--bal"><span>Balance</span><b>${money(t.balance)}</b></div>
      </div>
    </div>

    <div class="finTwo">
      ${raw(chartCard({
    tag: '¿A dónde se fue?', title: 'Gastos por categoría', slices: gastos,
    total: t.expense, lead: 'Tu mayor categoría de gasto es',
  }))}
      ${raw(chartCard({
    tag: '¿De dónde llegó?', title: 'Ingresos por categoría', slices: ingresos,
    total: t.income, lead: 'Tu principal fuente de ingresos es',
  }))}
    </div>`;
}

/* ============================ vista: CHECK LIST MENSUAL ============================ */
/** Obligaciones que toca pagar en el mes que se está viendo. */
function obligacionesDelMes() {
  const { from: desde, to: hasta } = range();
  const clave = periodoClave();
  const pagados = new Set(state.checks.filter((c) => c.period === clave).map((c) => c.budget_id));

  // Del presupuesto: gastos fijos y ahorros. Los variables son cupo, no obligación.
  const delPlan = state.budgets
    .filter((b) => b.active !== false && (b.kind === 'fixed' || b.kind === 'saving'))
    .map((b) => ({
      tipo: 'plan',
      id: b.id,
      nombre: b.name,
      monto: n(b.amount),
      grupo: KINDS[b.kind].label,
      icono: KINDS[b.kind].line,
      hecho: pagados.has(b.id),
    }));

  // Deudas que vencen dentro del mes (su estado sí es historial permanente).
  const deudas = state.debts
    .filter((d) => d.due_date && d.due_date >= desde && d.due_date <= hasta)
    .map((d) => ({
      tipo: 'deuda',
      id: d.id,
      nombre: d.person,
      concepto: d.concept,
      monto: n(d.amount),
      grupo: 'Deudas',
      icono: '💳',
      vence: d.due_date,
      hecho: d.status === 'paid',
    }));

  return { desde, hasta, items: [...delPlan, ...deudas] };
}

function viewChecklist() {
  const { desde, hasta, items } = obligacionesDelMes();
  const hechos = items.filter((i) => i.hecho);
  const total = sumBy(items, (i) => i.monto);
  const pagado = sumBy(hechos, (i) => i.monto);
  const avance = pct(hechos.length, items.length);

  const fila = (i) => html`
    <button class="finCheck ${i.hecho ? 'is-done' : ''}" type="button"
            data-check="${i.id}" data-tipo="${i.tipo}">
      <span class="finCheckBox">✓</span>
      <span class="finCheckText">
        <b>${i.icono} ${i.nombre}</b>
        <small>${i.grupo}${i.concepto ? ' · ' + i.concepto : ''}${i.vence ? ' · vence ' + i.vence : ''}</small>
      </span>
      <span class="finCheckAmt">${money(i.monto)}</span>
    </button>`;

  return html`
    <div class="finPanel">
      <div class="finPanelHead">
        <div>
          <span class="finTag finTag--lime">Lo que toca pagar</span>
          <h2>Check List mensual</h2>
          <p>${MESES[state.month - 1]} de ${state.year} · ${desde.slice(8)} al ${hasta.slice(8)}</p>
        </div>
      </div>

      <div class="finQProgress">
        <div class="finQNums">
          <b>${num(hechos.length)} de ${num(items.length)}</b>
          <i>${money(pagado)} de ${money(total)}</i>
        </div>
        <div class="finBar"><i style="width:${avance}%"></i></div>
        <div class="finWeekFoot">
          <span>${num(avance)}% del mes resuelto</span>
          <span>${items.length === hechos.length && items.length ? '¡Todo al día! 🎉' : 'Quedan ' + money(total - pagado)}</span>
        </div>
      </div>

      ${items.length
        ? H`<div class="finChecks">${raw(items.map(fila).join(''))}</div>`
        : H`<div class="finEmpty">No hay obligaciones activas ni deudas con vencimiento en este mes.</div>`}

      <p class="finNote">La lista empieza limpia cada mes y conserva las marcas de meses anteriores como historial.
      Las deudas mantienen además su estado de pago.</p>
    </div>`;
}

/* ============================ pintado ============================ */
const VIEWS = {
  movimientos: viewMovimientos,
  checklist: viewChecklist,
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
    const c = catById(x.category_id); const sub = subById(x.subcategory_id);
    return `<tr>
      <td>${esc(x.transaction_date)}</td>
      <td>${esc(x.description || sub?.name || c?.name || 'Movimiento')}</td>
      <td>${esc([c?.name, sub?.name].filter(Boolean).join(' · '))}</td>
      <td>${x.type === 'income' ? 'Ingreso' : 'Gasto'}</td>
      <td class="r ${x.type}">${x.type === 'income' ? '+' : '−'} ${esc(money(x.amount))}</td>
    </tr>`;
  }).join('');

  const deudas = state.debts.filter((d) => d.status !== 'paid');
  const plan = state.budgets.filter((b) => b.active !== false);

  const hoja = document.createElement('div');
  hoja.id = 'printArea';
  hoja.innerHTML = `
    <header>
      <h1>AS FINANZAS</h1>
      <p><b>${esc(p?.name || '')}</b>${p?.account_label ? ' · ' + esc(p.account_label) : ''}</p>
      <p>${esc(titulo)} · generado el ${esc(hoy)} · AS Suite v${esc(APP_VERSION)}</p>
    </header>
    <table class="tot">
      <tr><th>Ingresos</th><th>Gastos</th><th>Balance</th></tr>
      <tr><td>${esc(money(t.income))}</td><td>${esc(money(t.expense))}</td><td>${esc(money(t.balance))}</td></tr>
    </table>
    <h2>Movimientos (${lista.length})</h2>
    ${lista.length ? `<table class="mov">
      <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Tipo</th><th class="r">Monto</th></tr></thead>
      <tbody>${filas}</tbody></table>` : '<p>Sin movimientos en este rango.</p>'}
    ${plan.length ? `<h2>Plan del mes</h2>
      <table class="mov"><thead><tr><th>Obligación</th><th>Grupo</th><th>Frecuencia</th><th class="r">Monto</th></tr></thead>
      <tbody>${plan.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(KINDS[b.kind]?.label || b.kind)}</td>
        <td>Mensual</td>
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
function menuSheet() {
  const p = profile();
  sheet({
    title: 'Menú de Finanzas',
    body: html`
      <div class="finMenu">
        <button class="finMenuItem" type="button" data-m="nombre">
          <i>✍️</i><span><b>Cambiar nombre de usuario</b><small>Ahora eres “${p?.name || ''}”</small></span>
        </button>
        <button class="finMenuItem" type="button" data-m="pin">
          <i>🔑</i><span><b>Cambiar PIN de seguridad</b><small>Cuatro dígitos, se guarda cifrado</small></span>
        </button>
        <button class="finMenuItem" type="button" data-m="pdf">
          <i>📄</i><span><b>Exportar registros a PDF</b><small>Mes, año o todo el historial</small></span>
        </button>
        <button class="finMenuItem" type="button" data-m="colores">
          <i>🎨</i><span><b>Personalizar colores</b><small>Acento de tu cuenta</small></span>
        </button>
        <button class="finMenuItem finMenuItem--soft" type="button" data-m="salir">
          <i>🚪</i><span><b>Cerrar sesión</b><small>En este dispositivo</small></span>
        </button>
      </div>`,
    onOpen: ({ root: r, close }) => {
      $$('[data-m]', r).forEach((b) => b.addEventListener('click', () => {
        close();
        setTimeout(() => accionMenu(b.dataset.m), 190);
      }));
    },
    actions: [{ label: 'Cerrar', onClick: ({ close }) => close() }],
  });
}

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

  if (m === 'colores') {
    return sheet({
      title: 'Personalizar colores',
      body: html`
        <p class="sheetText">Elige el acento de tu cuenta. Todos mantienen el contraste
        del sistema, así que la app sigue viéndose como debe.</p>
        <div class="finAccents">
          ${raw(Object.entries(ACCENTS).map(([k, a]) => `
            <button class="finAccent" type="button" data-a="${esc(k)}"
                    aria-current="${(p?.accent || 'lima') === k}">
              <span style="background:${a.base}"></span>
              <span style="background:${a.deep}"></span>
              <b>${esc(a.label)}</b>
            </button>`).join(''))}
        </div>`,
      onOpen: ({ root: r, close }) => {
        $$('[data-a]', r).forEach((b) => b.addEventListener('click', async () => {
          const key = b.dataset.a;
          aplicarAcento({ accent: key });
          $$('[data-a]', r).forEach((x) => x.setAttribute('aria-current', String(x === b)));
          try {
            await Finance.updateProfile(state.profileId, { accent: key });
            const perfil = state.profiles.find((x) => x.id === state.profileId);
            if (perfil) perfil.accent = key;
            toast('Color aplicado');
          } catch { toast('No se pudo guardar el color', 'err'); }
          setTimeout(close, 450);
        }));
      },
      actions: [{ label: 'Listo', onClick: ({ close }) => close() }],
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

function txSheet(tx) {
  const editing = !!tx;
  const data = {
    type: tx?.type || 'expense',
    amount: tx ? n(tx.amount) : '',
    date: tx?.transaction_date || todayISO(),
    category_id: tx?.category_id || '',
    subcategory_id: tx?.subcategory_id || '',
    spend_type: tx?.spend_type || 'variable',
    description: tx?.description || '',
  };

  const catOpts = (type) => {
    const kinds = type === 'income' ? ['income'] : ['fixed', 'variable'];
    return state.cats.filter((c) => kinds.includes(c.kind));
  };

  sheet({
    title: editing ? 'Editar movimiento' : 'Nuevo movimiento',
    body: html`
      <div class="finForm">
        <div class="finSeg" data-seg="type">
          <button type="button" data-v="expense" aria-pressed="${data.type === 'expense'}">Gasto</button>
          <button type="button" data-v="income" aria-pressed="${data.type === 'income'}">Ingreso</button>
        </div>
        ${raw(field('Monto', `<input type="text" inputmode="numeric" autocomplete="off" data-f="amount" value="${formatCOPInput(data.amount)}" placeholder="$0">`))}
        <div class="finRowTwo">
          ${raw(field('Fecha', `<input type="date" data-f="date" value="${data.date}">`))}
          ${raw(field('Tipo de gasto', `<select data-f="spend_type">
            <option value="variable" ${data.spend_type !== 'fixed' ? 'selected' : ''}>Variable</option>
            <option value="fixed" ${data.spend_type === 'fixed' ? 'selected' : ''}>Fijo</option></select>`))}
        </div>
        ${raw(field('Categoría', `<select data-f="category_id"><option value="">— elige —</option>${
  optionList(catOpts(data.type), data.category_id, (c) => ({ value: c.id, label: `${c.emoji || ''} ${c.name}` }))}</select>`))}
        ${raw(field('Subcategoría', '<select data-f="subcategory_id"><option value="">— elige —</option></select>'))}
        ${raw(field('Descripción', `<input type="text" data-f="description" value="${esc(data.description)}" placeholder="Opcional">`))}
      </div>`,
    onOpen: ({ root: r, close }) => {
      const get = (f) => $(`[data-f="${f}"]`, r);
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
      paintSubs();

      $$('[data-seg="type"] button', r).forEach((btn) => btn.addEventListener('click', () => {
        data.type = btn.dataset.v;
        $$('[data-seg="type"] button', r).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        data.category_id = ''; data.subcategory_id = '';
        paintCats();
      }));
      get('category_id').addEventListener('change', () => { data.subcategory_id = ''; paintSubs(); });

      r.__save = async () => {
        const payload = {
          profile_id: state.profileId,
          type: data.type,
          amount: parseCOP(get('amount').value),
          transaction_date: get('date').value || todayISO(),
          category_id: get('category_id').value || null,
          subcategory_id: get('subcategory_id').value || null,
          spend_type: get('spend_type').value,
          description: get('description').value.trim(),
        };
        if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
          toast('Escribe un monto válido mayor que cero', 'err'); return;
        }
        // El momento del movimiento se fija al crearlo y no se toca al editar,
        // para no reescribir la hora real de algo registrado antes.
        if (!editing) payload.occurred_at = new Date().toISOString();
        try {
          if (editing) await Finance.updateTransaction(tx.id, payload);
          else await Finance.addTransaction(payload);
          close();
          await loadAll({ silent: true });
          toast(editing ? 'Movimiento actualizado' : 'Movimiento guardado');
        } catch { toast('No se pudo guardar', 'err'); }
      };
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Guardar', variant: 'primary', onClick: ({ root: r }) => r.__save?.() },
    ],
  });
}

function simpleSheet({ title, fields, onSave }) {
  sheet({
    title,
    body: html`<div class="finForm">${raw(fields.map((f) => {
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
  root.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'period') { state.period = e.target.value; paint(); }
  });

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; paint(); return; }

    /* --- check list mensual --- */
    const check = e.target.closest('[data-check]');
    if (check) {
      const id = check.dataset.check;
      const tipo = check.dataset.tipo;
      const clave = periodoClave();

      if (tipo === 'deuda') {
        const d = state.debts.find((x) => x.id === id);
        const pagada = d?.status === 'paid';
        if (d) d.status = pagada ? 'pending' : 'paid';   // respuesta inmediata
        paint();
        try {
          await Finance.updateDebt(id, {
            status: pagada ? 'pending' : 'paid',
            paid_at: pagada ? null : new Date().toISOString(),
          });
          toast(pagada ? 'Deuda de nuevo pendiente' : 'Deuda pagada ✓');
        } catch { toast('No se pudo actualizar', 'err'); loadAll({ silent: true }); }
        return;
      }

      const yaEsta = state.checks.some((c) => c.budget_id === id && c.period === clave);
      state.checks = yaEsta
        ? state.checks.filter((c) => !(c.budget_id === id && c.period === clave))
        : [...state.checks, { budget_id: id, period: clave, profile_id: state.profileId }];
      paint();
      try {
        if (yaEsta) await Checks.unmark(id, clave);
        else await Checks.mark(state.profileId, id, clave);
      } catch { toast('No se pudo guardar la marca', 'err'); loadAll({ silent: true }); }
      return;
    }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const p = profile();

    if (act === 'prev') return shiftMonth(-1);
    if (act === 'next') return shiftMonth(1);
    if (act === 'tools') return accionMenu('pdf');

    if (act === 'base') {
      return simpleSheet({
        title: 'Ingreso base del mes',
        fields: [{ key: 'base_income', label: 'Ingreso base', type: 'number', value: n(p?.base_income) }],
        onSave: (v) => Finance.updateProfile(state.profileId, { base_income: n(v.base_income) }),
      });
    }

    /* --- movimientos --- */
    if (act === 'tx-new') return txSheet(null);
    if (act === 'tx-edit' || act === 'tx-del') {
      const id = btn.closest('[data-tx]').dataset.tx;
      const tx = state.tx.find((t) => t.id === id);
      if (act === 'tx-edit') return txSheet(tx);
      return confirmSheet('Eliminar movimiento', '¿Borrar este movimiento? No se puede deshacer.', async () => {
        try { await Finance.removeTransaction(id); await loadAll({ silent: true }); toast('Movimiento eliminado'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- presupuesto --- */
    if (act === 'bud-new' || act === 'bud-edit') {
      const id = btn.closest('[data-budget]')?.dataset.budget;
      const b = state.budgets.find((x) => x.id === id);
      return simpleSheet({
        title: b ? 'Editar obligación' : 'Nueva obligación',
        fields: [
          { key: 'name', label: 'Nombre', value: b?.name || '', placeholder: 'Arriendo, Mercado…' },
          { key: 'amount', label: 'Monto del mes', type: 'number', value: b ? n(b.amount) : '' },
          {
            key: 'kind',
            label: 'Grupo',
            type: 'select',
            value: b?.kind || 'fixed',
            options: [
              { value: 'fixed', label: 'Gasto fijo' },
              { value: 'variable', label: 'Gasto variable' },
              { value: 'saving', label: 'Ahorro' },
            ],
          },
        ],
        onSave: (v) => {
          const payload = {
            profile_id: state.profileId, name: v.name.trim(), amount: n(v.amount),
            kind: v.kind,
          };
          return b ? Finance.updateBudget(b.id, payload) : Finance.addBudget(payload);
        },
      });
    }
    if (act === 'bud-del') {
      const id = btn.closest('[data-budget]').dataset.budget;
      return confirmSheet('Eliminar obligación', '¿Quitarla del plan del mes?', async () => {
        try { await Finance.removeBudget(id); await loadAll({ silent: true }); toast('Obligación eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- metas --- */
    if (act === 'goal-new' || act === 'goal-edit' || act === 'goal-img') {
      const id = btn.closest('[data-goal]')?.dataset.goal;
      const g = state.goals.find((x) => x.id === id);
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
      return confirmSheet('Eliminar meta', '¿Borrar esta meta de ahorro?', async () => {
        try { await Finance.removeGoal(id); await loadAll({ silent: true }); toast('Meta eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }

    /* --- categorías --- */
    if (act === 'cat-new' || act === 'cat-edit') {
      const id = btn.closest('[data-cat]')?.dataset.cat;
      const c = state.cats.find((x) => x.id === id);
      const kind = c?.kind || btn.dataset.kind || 'variable';
      return simpleSheet({
        title: c ? 'Editar categoría' : 'Nueva categoría',
        fields: [
          { key: 'emoji', label: 'Emoji', value: c?.emoji || '📦' },
          { key: 'name', label: 'Nombre', value: c?.name || '' },
        ],
        onSave: (v) => {
          const payload = { name: v.name.trim(), emoji: v.emoji.trim() || '📦', kind };
          if (c) return Finance.updateCategory(c.id, payload);
          return Finance.addCategory({ ...payload, slug: norm(v.name).replace(/\s+/g, '-') });
        },
      });
    }
    if (act === 'cat-del') {
      const id = btn.closest('[data-cat]').dataset.cat;
      return confirmSheet('Eliminar categoría', 'Se borra la categoría y sus subcategorías.', async () => {
        try { await Finance.removeCategory(id); await loadAll({ silent: true }); toast('Categoría eliminada'); }
        catch { toast('No se pudo eliminar', 'err'); }
      });
    }
    if (act === 'sub-new' || act === 'sub-edit') {
      const catId = btn.closest('[data-cat]').dataset.cat;
      const id = btn.closest('[data-sub]')?.dataset.sub;
      const s = state.subs.find((x) => x.id === id);
      return simpleSheet({
        title: s ? 'Editar subcategoría' : 'Nueva subcategoría',
        fields: [
          { key: 'emoji', label: 'Emoji', value: s?.emoji || '•' },
          { key: 'name', label: 'Nombre', value: s?.name || '' },
        ],
        onSave: (v) => {
          const payload = { name: v.name.trim(), emoji: v.emoji.trim() || '•' };
          return s ? Finance.updateSub(s.id, payload) : Finance.addSub({ ...payload, category_id: catId });
        },
      });
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
          { key: 'due_date', label: 'Vence', type: 'date', value: d?.due_date || '' },
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
        toast(paid ? 'Marcada como pendiente' : 'Deuda pagada ✓');
      } catch { toast('No se pudo actualizar', 'err'); }
      return;
    }
    if (act === 'debt-del') {
      const id = btn.closest('[data-debt]').dataset.debt;
      return confirmSheet('Eliminar deuda', '¿Borrar esta obligación?', async () => {
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

  hydrate();
  aplicarAcento(profile());
  paint();
  wire();

  try { await loadAll({ silent: true }); }
  catch { if (!state.loaded) toast('Sin conexión: mostrando lo último guardado', 'err'); }

  watch('finance', ['finance_transactions', 'budgets', 'savings_goals', 'debts',
    'finance_categories', 'finance_subcategories', 'profiles', 'budget_checks'],
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
