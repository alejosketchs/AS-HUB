// AS HUB — TASK//GRID (módulo de Tareas)
// Copia servida desde el espejo: resuelve sus dependencias contra el sitio
// que la está usando, así comparte la misma instancia de datos que el resto.
const { Tasks, Projects, Notes, Agenda, watch, unwatch, readCache, writeCache } =
  await import(new URL('/js/db.js', location.origin).href);
const { $, $$, html, raw, esc, toast, sheet, confirmSheet, todayISO, addDays } =
  await import(new URL('/js/ui.js', location.origin).href);
const { perfilActivo, sesion } = await import(new URL('/js/session.js', location.origin).href);
const { SUPABASE_URL, SUPABASE_KEY } = await import(new URL('/js/config.js', location.origin).href);

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" width="19" height="19" aria-hidden="true">${d}</svg>`;

const ICONS = {
  grid: svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
  today: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
  week: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M12 13v5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  note: svg('<path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
};

const SECTIONS = [
  { id: 'hoy', icon: ICONS.today, label: 'Hoy' },
  { id: 'tareas', icon: ICONS.grid, label: 'Tareas' },
  { id: 'agenda', icon: ICONS.week, label: 'Agenda' },
  { id: 'proyectos', icon: ICONS.folder, label: 'Proyectos' },
  { id: 'recordatorios', icon: ICONS.note, label: 'Recordatorios' },
];

const QUADS = {
  1: { code: 'Q1', title: 'HACER AHORA', sub: 'Urgente + importante', tag: 'Q1 · URGENTE + IMPORTANTE' },
  2: { code: 'Q2', title: 'PLANIFICAR', sub: 'Importante, no urgente', tag: 'Q2 · IMPORTANTE' },
  3: { code: 'Q3', title: 'DELEGAR', sub: 'Urgente, no importante', tag: 'Q3 · URGENTE' },
  4: { code: 'Q4', title: 'ALGÚN DÍA', sub: 'Ni urgente ni importante', tag: 'Q4 · ALGÚN DÍA' },
};

const DURATIONS = [30, 60, 90, 120, 150, 180, 210, 240];
const NOTE_COLORS = ['#ffd523', '#a8ff1e', '#8bd8ff', '#ff9ecb', '#d5b8ff', '#ffb37a'];

const DIAS_LARGOS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
const DIAS_CORTOS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const SLOT_H = 34;
const DAY_START = 6;
const DAY_END = 23;

let root;
let state = {
  section: 'hoy',
  weekStart: null,
  projectFilter: null,
  capture: { urgent: false, important: false },
  picked: null,
  noteQuery: '',
  preferredPeriod: localStorage.getItem('ashub:tasks:preferred-period') || 'afternoon',
  nowTimer: null,
  google: { loading: false, connected: false, configured: false, connection: null },
  tasks: [], projects: [], notes: [], events: [],
};

const pad2 = (n) => String(n).padStart(2, '0');
const dateAt = (iso) => new Date(iso + 'T12:00:00');

function quadOf(t) {
  if (!t.classified) return null;
  if (t.urgent && t.important) return 1;
  if (!t.urgent && t.important) return 2;
  if (t.urgent && !t.important) return 3;
  return 4;
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

function fmtTime(t) {
  if (!t) return '';
  const [H, M] = t.split(':').map(Number);
  const suffix = H < 12 ? 'a. m.' : 'p. m.';
  const h = H % 12 === 0 ? 12 : H % 12;
  return `${h}:${pad2(M)} ${suffix}`;
}

const minutesOf = (t) => {
  const [H, M] = t.split(':').map(Number);
  return H * 60 + M;
};
const timeFromMinutes = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

function startOfWeek(iso) {
  const d = dateAt(iso);
  d.setDate(d.getDate() - d.getDay());
  return d.toLocaleDateString('en-CA');
}

const projectOf = (id) => state.projects.find((p) => p.id === id);
const activeTasks = () => state.tasks.filter((t) => !t.archived_at);
const pending = () => activeTasks().filter((t) => t.status !== 'done');
const visibleForProfile = (row) => !row.profile_id || row.profile_id === perfilActivo()?.id;

function sectionFromHash() {
  const part = (location.hash.match(/^#\/tareas\/([^?]+)/) || [])[1];
  if (part === 'pendientes') return 'tareas';
  return SECTIONS.some((s) => s.id === part) ? part : 'hoy';
}

const routeFor = (section) => `#/tareas/${section === 'tareas' ? 'pendientes' : section}`;

function daysUntil(iso) {
  if (!iso) return 999;
  return Math.round((dateAt(iso) - dateAt(todayISO())) / 864e5);
}

function taskScore(t) {
  const q = quadOf(t) || 4;
  const base = { 1: 600, 2: 400, 3: 200, 4: 100 }[q];
  const left = daysUntil(t.due_date);
  const due = left < 0 ? 260 : left === 0 ? 190 : left === 1 ? 140 : left <= 3 ? 80 : 0;
  return base + due - Math.min(60, (Number(t.duration_min) || 30) / 4);
}

function freeGaps(iso, { futureOnly = false } = {}) {
  const busy = dayItems(iso).map((item) => ({
    start: Math.max(DAY_START * 60, minutesOf(item.start)),
    end: Math.min(DAY_END * 60, minutesOf(item.end)),
  })).filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const now = new Date();
  let cursor = DAY_START * 60;
  if (futureOnly && iso === todayISO()) cursor = Math.max(cursor, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30);
  const gaps = [];
  busy.forEach((block) => {
    if (block.start > cursor) gaps.push({ start: cursor, end: block.start, minutes: block.start - cursor });
    cursor = Math.max(cursor, block.end);
  });
  if (cursor < DAY_END * 60) gaps.push({ start: cursor, end: DAY_END * 60, minutes: DAY_END * 60 - cursor });
  return gaps.filter((g) => g.minutes >= 30);
}

function suggestionsFor(iso, limit = 3) {
  const target = state.preferredPeriod === 'morning' ? 9 * 60 : state.preferredPeriod === 'night' ? 19 * 60 : 14 * 60;
  const gaps = freeGaps(iso, { futureOnly: true }).sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target));
  const unscheduled = pending().filter((t) => !t.scheduled_date && Number(t.duration_min || 30) <= 240)
    .sort((a, b) => taskScore(b) - taskScore(a));
  const used = new Set();
  const suggestions = [];
  gaps.forEach((gap) => {
    const task = unscheduled.find((t) => !used.has(t.id) && Number(t.duration_min || 30) <= gap.minutes);
    if (!task || suggestions.length >= limit) return;
    used.add(task.id);
    suggestions.push({ task, gap });
  });
  return { gaps, suggestions };
}

function reasonFor(t, gap) {
  const q = quadOf(t) || 4;
  const left = daysUntil(t.due_date);
  const due = left < 0 ? 'está vencida' : left === 0 ? 'vence hoy' : left === 1 ? 'vence mañana' : t.due_date ? `vence en ${left} días` : 'no tiene fecha límite';
  return `${due}, es Q${q} y cabe en tu hueco de ${fmtDuration(gap.minutes)}`;
}

function overloadForWeek() {
  const end = addDays(todayISO(), 6);
  const due = pending().filter((t) => t.due_date && t.due_date <= end && !t.scheduled_date);
  const required = due.reduce((sum, t) => sum + Number(t.duration_min || 30), 0);
  let available = 0;
  for (let i = 0; i < 7; i += 1) available += freeGaps(addDays(todayISO(), i), { futureOnly: i === 0 }).reduce((sum, g) => sum + g.minutes, 0);
  return { required, available, tasks: due.sort((a, b) => taskScore(b) - taskScore(a)).slice(0, 3) };
}

function statsHTML() {
  const open = pending();
  const stats = [
    { label: 'PENDIENTES', value: open.length },
    { label: 'SIN CLASIFICAR', value: open.filter((t) => !t.classified).length },
    { label: 'URGENTES', value: open.filter((t) => t.urgent).length },
    { label: 'EN AGENDA', value: open.filter((t) => t.scheduled_date).length, hi: true },
  ];
  return html`<div class="tgStats">${raw(stats.map((s) => `
    <article class="tgStat ${s.hi ? 'tgStat--hi' : ''}">
      <span>${esc(s.label)}</span><b>${pad2(s.value)}</b>
    </article>`).join(''))}</div>`;
}

function taskCardHTML(t, { draggable = false, mini = false } = {}) {
  const q = quadOf(t);
  const proj = projectOf(t.project_id);
  const meta = [proj ? proj.name.toUpperCase() : 'SIN PROYECTO'];
  if (t.due_date) meta.push(`LÍMITE ${t.due_date}`);

  const chips = [`<span class="tgChip">⏱ ${esc(fmtDuration(t.duration_min))}</span>`];
  const elapsed = Number(t.timer_elapsed_sec || 0) + (t.timer_started_at
    ? Math.max(0, Math.floor((Date.now() - new Date(t.timer_started_at).getTime()) / 1000)) : 0);
  if (elapsed) chips.push(`<span class="tgChip">◷ ${esc(fmtDuration(Math.max(1, Math.round(elapsed / 60))))} real</span>`);
  if (!mini && t.scheduled_date) {
    chips.push(`<span class="tgChip">▤ ${esc(t.scheduled_date)} · ${esc(fmtTime(t.scheduled_time))}</span>`);
  }

  return html`
    <article class="tgTask ${mini ? 'tgTask--mini' : ''} ${t.status === 'done' ? 'is-done' : ''} ${state.picked?.id === t.id ? 'is-picked' : ''}"
             data-task="${t.id}" style="--qe:${q ? `var(--q${q}-edge)` : '#8a8a80'}"
             ${raw(draggable ? 'draggable="true"' : '')}>
      <div class="tgTaskTop">
        <button class="tgCheck" type="button" data-act="toggle" aria-label="Completar">✓</button>
        <div class="tgTaskTitle">${t.title}</div>
        <div class="tgIcons">
          <button type="button" data-act="edit" aria-label="Editar">✎</button>
          <button type="button" data-act="timer" aria-label="${t.timer_started_at ? 'Pausar' : 'Iniciar'} temporizador">${t.timer_started_at ? 'Ⅱ' : '▶'}</button>
          <button type="button" data-act="del" aria-label="Archivar">⌫</button>
        </div>
      </div>
      <div class="tgTaskMeta">${meta.join(' · ')}</div>
      <div class="tgChips">${raw(chips.join(''))}</div>
      ${raw(mini ? '' : `<button class="tgLink" type="button" data-act="schedule">${t.scheduled_date ? '→ Reprogramar' : '→ Llevar a agenda'}</button>`)}
    </article>`;
}

function viewTareas() {
  const filter = state.projectFilter ? projectOf(state.projectFilter) : null;
  const visible = pending().filter((t) => !filter || t.project_id === filter.id);

  const quads = [1, 2, 3, 4].map((q) => {
    const list = visible.filter((t) => quadOf(t) === q);
    const meta = QUADS[q];
    return html`
      <section class="tgQuad" style="--q:var(--q${q});--qe:var(--q${q}-edge)">
        <span class="tgQuadNum">${String(list.length)}</span>
        <small>${meta.code}</small>
        <h4>${meta.title}</h4>
        <p>${meta.sub}</p>
        ${raw(list.length
          ? `<div class="tgQuadList">${list.map((t) => taskCardHTML(t)).join('')}</div>`
          : '<div class="tgQuadEmpty">Nada por aquí. Buena señal.</div>')}
      </section>`;
  }).join('');

  const sinClasificar = visible.filter((t) => !t.classified);

  return html`
    ${raw(statsHTML())}

    ${raw(filter ? `<div class="tgAxis"><b>Filtrando por ${esc(filter.emoji)} ${esc(filter.name)}</b>
      <button class="tgBtn tgBtn--plain tgBtn--sm" type="button" data-act="clearfilter">QUITAR FILTRO</button></div>` : '')}

    <div class="tgAxis">
      <small>IMPORTANCIA ↑</small>
      <b>Prioridad = urgente × importante</b>
      <small>URGENCIA →</small>
    </div>
    <div class="tgMatrix">${raw(quads)}</div>

    ${raw(sinClasificar.length ? `
      <div class="tgAxis" style="margin-top:26px"><small>SIN CLASIFICAR</small></div>
      <div class="tgQuadList">${sinClasificar.map((t) => taskCardHTML(t)).join('')}</div>` : '')}`;
}

function viewHoy() {
  const today = todayISO();
  const items = dayItems(today).sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  const candidates = pending().filter((t) => t.due_date === today || !t.scheduled_date || t.scheduled_date === today)
    .sort((a, b) => taskScore(b) - taskScore(a));
  const focus = candidates[0] || null;
  const { gaps, suggestions } = suggestionsFor(today, 3);
  const overload = overloadForWeek();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const missed = pending().filter((t) => t.scheduled_date === today && t.scheduled_time
    && minutesOf(t.scheduled_time.slice(0, 5)) + Number(t.duration_min || 30) < nowMin);
  const weekStart = startOfWeek(today);
  const month = today.slice(0, 7);
  const doneWeek = activeTasks().filter((t) => t.status === 'done' && t.completed_at?.slice(0, 10) >= weekStart).length;
  const doneMonth = activeTasks().filter((t) => t.status === 'done' && t.completed_at?.startsWith(month)).length;
  const completedMonth = activeTasks().filter((t) => t.status === 'done' && t.completed_at?.startsWith(month));
  const estimatedMonth = completedMonth.reduce((sum, t) => sum + Number(t.duration_min || 0), 0);
  const actualMonth = completedMonth.reduce((sum, t) => sum + Number(t.actual_duration_min || t.duration_min || 0), 0);

  const timeline = items.length ? html`<div class="tgTimeline">${raw(items.map((it) => `
    <button class="tgTimeItem" type="button" data-${it.kind === 'task' ? 'task' : 'event'}="${it.id}"
      style="background:${it.kind === 'task' ? `var(--q${it.quad || 4})` : 'var(--q2)'}">
      <b>${esc(fmtTime(it.start))}</b><span>${esc(it.title)}</span>
      <b class="tgTimeDuration">${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</b>
    </button>`).join(''))}</div>` : '<div class="tgQuadEmpty">Hoy no tienes nada agendado.</div>';

  return html`
    ${raw(missed.length ? `<section class="tgMissed"><b>No completaste “${esc(missed[0].title)}”.</b><span>¿Qué quieres hacer?</span>
      <div><button data-act="missed-reschedule" data-id="${missed[0].id}">Reprogramar</button>
      <button data-act="missed-pending" data-id="${missed[0].id}">Mantener pendiente</button>
      <button data-act="missed-complete" data-id="${missed[0].id}">Completar</button></div></section>` : '')}
    ${raw(overload.required > overload.available ? `<section class="tgOverload"><b>Tu semana está sobrecargada.</b>
      <p>Tienes ${esc(fmtDuration(overload.required))} de tareas próximas y ${esc(fmtDuration(overload.available))} libres. Empieza por: ${overload.tasks.map((t) => esc(t.title)).join(' · ')}</p></section>` : '')}
    <section class="tgNow">
      <span>// LO MÁS URGENTE AHORA</span>
      ${raw(focus ? `<h2>${esc(focus.title)}</h2><p>${focus.due_date ? (daysUntil(focus.due_date) < 0 ? 'Vencida' : daysUntil(focus.due_date) === 0 ? 'Vence hoy' : 'Límite ' + esc(focus.due_date)) : 'Sin fecha límite'} · ${esc(fmtDuration(focus.duration_min))} · Q${quadOf(focus) || 4}</p>
        <div class="tgNowActions"><button class="tgBtn tgBtn--ink" data-act="do-now" data-id="${focus.id}">HACER AHORA</button>
        <button class="tgBtn tgBtn--plain" data-act="schedule" data-task-id="${focus.id}">AGENDAR</button></div>`
        : '<div class="tgQuadEmpty">No tienes tareas pendientes. Buena señal.</div>')}
    </section>
    <div class="tgTodayGrid">
      <section class="tgCard"><h4>AGENDA DE HOY</h4><p>Compromisos y tareas ya agendadas.</p>${raw(timeline)}</section>
      <section class="tgCard"><h4>TAREAS PARA HOY</h4><p>Solo las que vencen o están agendadas hoy.</p>
        ${raw((pending().filter((t) => t.due_date === today || t.scheduled_date === today).slice(0, 5).map((t) => taskCardHTML(t)).join('')) || '<div class="tgQuadEmpty">Nada pendiente para hoy.</div>')}</section>
    </div>
    <section class="tgCard tgSuggestions"><div class="tgSectionHead"><div><h4>SUGERENCIAS</h4><p>${gaps.length ? `Detecté ${gaps.length} huecos libres hoy.` : 'No quedan huecos de 30 minutos hoy.'}</p></div><a class="tgBtn tgBtn--plain tgBtn--sm" href="#/tareas/agenda">PLAN DE LA SEMANA</a></div>
      ${raw(suggestions.length ? `<div class="tgSuggestGrid">${suggestions.map(({ task, gap }) => `<article><b>${esc(task.title)}</b><span>${esc(fmtDuration(task.duration_min))} · Q${quadOf(task) || 4}</span><p>Te la recomiendo porque ${esc(reasonFor(task, gap))}.</p><button data-act="accept-suggestion" data-id="${task.id}" data-date="${today}" data-time="${timeFromMinutes(gap.start)}">Agendar ${esc(fmtTime(timeFromMinutes(gap.start)))}</button></article>`).join('')}</div>` : '<div class="tgQuadEmpty">No hay una sugerencia útil en este momento.</div>')}
    </section>
    <div class="tgMiniStats"><span><b>${doneWeek}</b> completadas esta semana</span><span><b>${doneMonth}</b> completadas este mes</span><span><b>${pending().filter((t) => t.due_date && t.due_date < today).length}</b> vencidas</span><span><b>${pending().reduce((s, t) => s + Number(t.reschedule_count || 0), 0)}</b> reprogramaciones</span><span><b>${esc(fmtDuration(estimatedMonth))}</b> estimado · ${esc(fmtDuration(actualMonth))} real</span></div>`;
}

function dayItems(iso) {
  const dow = dateAt(iso).getDay();
  const out = [];

  state.events.forEach((e) => {
    if ((e.recurrence_exceptions || []).some((x) => x.date === iso && x.cancelled)) return;
    let applies = false;
    if (e.recurrence === 'none') applies = e.event_date === iso;
    else if (iso >= e.event_date && (!e.repeat_until || iso <= e.repeat_until)) {
      if (e.recurrence === 'weekdays') applies = dow >= 1 && dow <= 5;
      else if (e.recurrence === 'weekly') applies = dateAt(e.event_date).getDay() === dow;
      else if (e.recurrence === 'daily') applies = true;
      else if (e.recurrence === 'monthly') applies = dateAt(e.event_date).getDate() === dateAt(iso).getDate();
    }
    if (applies) {
      out.push({
        kind: 'event', id: e.id, title: e.title,
        start: e.start_time.slice(0, 5), end: e.end_time.slice(0, 5), color: e.color,
      });
    }
  });

  state.tasks.filter((t) => t.scheduled_date === iso && t.scheduled_time).forEach((t) => {
    const start = t.scheduled_time.slice(0, 5);
    out.push({
      kind: 'task', id: t.id, title: t.title, quad: quadOf(t), done: t.status === 'done',
      start, end: timeFromMinutes(minutesOf(start) + t.duration_min),
    });
  });

  return out;
}

function viewAgenda() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const today = todayISO();
  const anchor = dateAt(days[3]);
  const monthLabel = `${MESES[anchor.getMonth()]} de ${anchor.getFullYear()}`;

  const libres = pending().filter((t) => !t.scheduled_date);
  const groups = [1, 2, 3, 4].map((q) => {
    const list = libres.filter((t) => quadOf(t) === q);
    return html`
      <details class="tgDragGroup" style="--q:var(--q${q});--qe:var(--q${q}-edge)" ${raw(list.length ? 'open' : '')}>
        <summary>${QUADS[q].tag}<span class="tgBadge">${String(list.length)}</span></summary>
        ${raw(list.length
          ? `<div class="tgDragBody">${list.map((t) => taskCardHTML(t, { draggable: true, mini: true })).join('')}</div>`
          : '')}
      </details>`;
  }).join('');

  const head = days.map((iso, i) => {
    const d = dateAt(iso);
    return `<th class="${iso === today ? 'is-today' : ''}">${DIAS_CORTOS[i]}<b>${d.getDate()}</b></th>`;
  }).join('');

  const rows = [];
  for (let m = DAY_START * 60; m < DAY_END * 60; m += 30) {
    const label = fmtTime(timeFromMinutes(m));
    const cells = days.map((iso) => {
      const items = dayItems(iso).filter((it) => minutesOf(it.start) === m);
      const inner = items.map((it) => {
        const span = Math.max(1, Math.round((minutesOf(it.end) - minutesOf(it.start)) / 30));
        const h = span * SLOT_H - 5;
        if (it.kind === 'event') {
          return `<div class="tgEvent" data-event="${it.id}" data-date="${iso}" draggable="true" style="height:${h}px;border-left-color:${esc(it.color)}">
            <small>${esc(fmtTime(it.start))} → ${esc(fmtTime(it.end))}</small>
            <b>${esc(it.title)}</b>
            <i>${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</i>
            <button class="tgEventMove" data-act="pickevent" aria-label="Mover compromiso">✥</button>
          </div>`;
        }
        return `<div class="tgEvent tgEvent--task q${it.quad || 4} ${it.done ? 'is-done' : ''}"
                     data-task="${it.id}" draggable="true" style="height:${h}px">
          <button class="tgEventDone" type="button" data-act="toggle" aria-label="Completar">✓</button>
          <small>${esc(fmtTime(it.start))}</small>
          <b>${esc(it.title)}</b>
          <i>${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</i>
          <span class="tgResize"><button data-act="shrink" aria-label="Reducir 30 minutos">−</button><button data-act="grow" aria-label="Aumentar 30 minutos">＋</button></span>
        </div>`;
      }).join('');
      return `<td class="tgSlot" data-date="${iso}" data-time="${timeFromMinutes(m)}">${inner}</td>`;
    }).join('');
    rows.push(`<tr><th class="tgHour">${esc(label)}</th>${cells}</tr>`);
  }

  return html`
    ${raw(statsHTML())}

    <div class="tgMonthBar">
      <div class="tgMonthNav">
        <button class="tgArrow" type="button" data-act="prevweek" aria-label="Semana anterior">‹</button>
        <div>
          <div class="tgMonthName">${monthLabel}</div>
          <div class="tgMonthSub">Domingo a sábado · bloques de 30 minutos</div>
        </div>
        <button class="tgArrow" type="button" data-act="nextweek" aria-label="Semana siguiente">›</button>
      </div>
      <button class="tgBtn" type="button" data-act="newevent">+ AGREGAR COMPROMISO</button>
    </div>

    <div class="tgAgenda">
      <aside class="tgDrag">
        <div class="tgDragHead">
          <div>
            <h4>ARRASTRABLES</h4>
            <p>Despliega Q1–Q4 · toca o arrastra</p>
          </div>
          <span class="tgBadge">${String(libres.length)}</span>
        </div>
        <div class="tgDragGroups">${raw(groups)}</div>
      </aside>

      <div class="tgGridWrap">
        <table class="tgGrid">
          <thead><tr><th class="tgHour">HORA</th>${raw(head)}</tr></thead>
          <tbody>${raw(rows.join(''))}</tbody>
        </table>
      </div>
    </div>
    <section class="tgWeekPlan">
      <div class="tgSectionHead"><div><span>// PLAN AUTOMÁTICO</span><h3>PLAN DE LA SEMANA</h3><p>Sugerencias, no movimientos automáticos.</p></div>
      <div class="tgPlanControls"><label>Prefiero trabajar <select class="select" id="tgPreferredPeriod"><option value="morning" ${state.preferredPeriod === 'morning' ? 'selected' : ''}>en la mañana</option><option value="afternoon" ${state.preferredPeriod === 'afternoon' ? 'selected' : ''}>en la tarde</option><option value="night" ${state.preferredPeriod === 'night' ? 'selected' : ''}>en la noche</option></select></label><button class="tgBtn tgBtn--plain" type="button" data-act="todayweek">VOLVER A ESTA SEMANA</button></div></div>
      <div class="tgWeekSuggestions">${raw(days.map((iso) => {
        const suggestion = suggestionsFor(iso, 1).suggestions[0];
        const d = dateAt(iso);
        return `<article><b>${DIAS_CORTOS[d.getDay()]} ${d.getDate()}</b>${suggestion
          ? `<span>${esc(suggestion.task.title)}</span><small>${esc(fmtTime(timeFromMinutes(suggestion.gap.start)))} · ${esc(fmtDuration(suggestion.task.duration_min))}</small><button data-act="accept-suggestion" data-id="${suggestion.task.id}" data-date="${iso}" data-time="${timeFromMinutes(suggestion.gap.start)}">Agendar</button>`
          : '<span>Sin sugerencia</span><small>Agenda llena o sin pendientes compatibles.</small>'}</article>`;
      }).join(''))}</div>
    </section>
    <section class="tgCalendarSync"><div><span>GOOGLE CALENDAR</span><h3>${state.google.connected ? 'Cuenta conectada' : state.google.configured ? 'Conecta tu calendario' : 'OAuth seguro instalado'}</h3>
      <p>${state.google.connected
        ? `Sincronización bidireccional activa.${state.google.connection?.last_sync_at ? ` Última: ${esc(new Date(state.google.connection.last_sync_at).toLocaleString('es-CO'))}.` : ''}`
        : state.google.configured ? 'Autoriza Google para importar y publicar tareas y compromisos.' : 'La función está protegida en servidor. Falta cargar las credenciales del cliente OAuth de Google.'}</p></div>
      <div class="tgCalendarActions">${raw(state.google.connected
        ? '<button class="tgBtn" type="button" data-act="calendar-sync">SINCRONIZAR</button><button class="tgBtn tgBtn--plain" type="button" data-act="calendar-disconnect">DESCONECTAR</button>'
        : state.google.configured ? '<button class="tgBtn" type="button" data-act="calendar-connect">CONECTAR GOOGLE</button>'
          : '<button class="tgBtn tgBtn--plain" type="button" data-act="calendar-info">VER CONFIGURACIÓN</button>')}</div></section>`;
}

function viewProyectos() {
  const cards = state.projects.map((p) => {
    const all = state.tasks.filter((t) => t.project_id === p.id);
    const open = all.filter((t) => t.status !== 'done' && !t.archived_at);
    const done = all.filter((t) => t.status === 'done' && !t.archived_at);
    const progress = all.length ? Math.round((done.length / all.length) * 100) : 0;
    const avatar = p.image_url
      ? `<img src="${esc(p.image_url)}" alt="">`
      : esc((p.name || '?').trim().charAt(0).toUpperCase());
    return html`
      <article class="tgProj" data-proj="${p.id}" style="--pc:${p.color}">
        <div class="tgProjTop">
          <div class="tgAvatar">${raw(avatar)}</div>
          <div class="tgProjName">
            <b>${p.name}</b>
            <small>${String(open.length)} pendientes · ${String(done.length)} completadas</small>
            <span class="tgProgress"><i style="width:${progress}%"></i></span>
          </div>
          <div class="tgProjActions">
            <button class="tgBtn tgBtn--sm tgProjOpen" type="button" data-act="openproj">Abrir</button>
            <button class="tgBtn tgBtn--sm" type="button" data-act="editproj">✎ Editar</button>
          </div>
        </div>
        <details class="tgProjBody">
          <summary>▶ Ver tareas <span class="tgBadge">${String(open.length)}</span></summary>
          ${raw(all.length
            ? `<div class="tgProjTasks">${all.filter((t) => !t.archived_at).map((t) => taskCardHTML(t)).join('')}</div>`
            : '<div class="tgQuadEmpty">Este proyecto aún no tiene tareas.</div>')}
        </details>
      </article>`;
  }).join('');

  return html`
    ${raw(statsHTML())}
    <div class="tgProjHead">
      <div>
        <h3>MIS PROYECTOS</h3>
        <p>Imagen, color y espacio propio para cada proyecto.</p>
      </div>
      <button class="tgBtn tgBtn--blue" type="button" data-act="newproj">+ NUEVO PROYECTO</button>
    </div>
    <div class="tgProjList">${raw(cards || '<div class="tgQuadEmpty">Aún no hay proyectos.</div>')}</div>`;
}

function viewRecordatorios() {
  const q = state.noteQuery.trim().toLocaleLowerCase('es');
  const visible = state.notes.filter((n) => !q || n.body.toLocaleLowerCase('es').includes(q));
  const notes = visible.map((n) => html`
    <article class="tgNote" data-note="${n.id}" style="background:${n.color}">
      <textarea data-act="notebody" placeholder="Escribe…">${n.body}</textarea>
      <div class="tgNoteMeta">${n.remind_at ? `⏰ ${esc(new Date(n.remind_at).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }))}` : 'Sin aviso'}${n.notification_enabled ? ' · notificación activa' : ''}</div>
      <div class="tgNoteFoot">
        <button class="tgReviewed" type="button" data-act="review" aria-pressed="${n.reviewed ? 'true' : 'false'}">Revisado</button>
        <button class="tgReviewed" type="button" data-act="editnote">Aviso</button>
        <button class="tgNoteX" type="button" data-act="notedel" aria-label="Borrar">✕</button>
      </div>
    </article>`).join('');

  return html`
    <div class="tgReminderTools"><label>Buscar recordatorios <input class="input" id="tgNoteSearch" type="search" value="${state.noteQuery}" placeholder="Texto de la nota"></label>
      <button class="tgBtn tgBtn--plain tgBtn--sm" type="button" data-act="notifications">ACTIVAR NOTIFICACIONES</button></div>
    <form class="tgNoteNew" id="tgNoteNew">
      <textarea id="tgNoteInput" placeholder="¿Qué necesitas recordar o pensar?"></textarea>
      <button class="tgBtn" type="submit">PEGAR NOTA</button>
    </form>
    <div class="tgNotes">${raw(notes || '<div class="tgQuadEmpty">Sin notas todavía.</div>')}</div>`;
}

function paint() {
  const main = $('#tgMain', root);
  if (!main) return;

  const today = dateAt(todayISO());
  const kicker = `// ${DIAS_LARGOS[today.getDay()]}, ${today.getDate()} DE ${MESES[today.getMonth()].toUpperCase()}`;
  const titles = {
    tareas: 'TAREAS', hoy: 'HOY', agenda: 'AGENDA',
    proyectos: 'PROYECTOS', recordatorios: 'RECORDATORIOS',
  };
  const views = {
    tareas: viewTareas, hoy: viewHoy, agenda: viewAgenda,
    proyectos: viewProyectos, recordatorios: viewRecordatorios,
  };

  main.innerHTML = html`
    <div class="tgHead">
      <div>
        <div class="tgKicker">${kicker}</div>
        <h1 class="tgTitle">${titles[state.section]}</h1>
      </div>
      <button class="tgBtn" type="button" data-act="newtask">＋ NUEVA TAREA</button>
    </div>
    ${raw(views[state.section]())}`;

  $$('.tgNav [data-section]', root).forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.section === state.section));
  });

  $$('.tgNote textarea', main).forEach(autosize);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(120, ta.scrollHeight)}px`;
}

async function reload({ silent = false } = {}) {
  try {
    const [tasks, projects, notes, events] = await Promise.all([
      Tasks.list(), Projects.list(), Notes.list(), Agenda.list(),
    ]);
    const scoped = {
      tasks: tasks.filter(visibleForProfile),
      projects: projects.filter(visibleForProfile).filter((p) => !p.archived),
      notes: notes.filter(visibleForProfile).filter((n) => n.status !== 'done'),
      events: events.filter(visibleForProfile).filter((e) => !e.archived_at),
    };
    state = { ...state, ...scoped };
    writeCache(`tgModule:${perfilActivo()?.id || 'legacy'}`, scoped);
    paint();
  } catch {
    if (!silent) toast('Sin conexión: viendo la última copia', 'info');
  }
}

async function googleRequest(action) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/google-calendar`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      'x-as-session': sesion()?.token || '',
    },
    body: JSON.stringify({ action }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `OAuth respondió ${response.status}`);
  return payload;
}

async function loadGoogleStatus({ silent = false } = {}) {
  if (state.section !== 'agenda') return;
  try {
    const status = await googleRequest('status');
    state.google = { ...state.google, ...status, loading: false };
    paint();
  } catch (error) {
    state.google.loading = false;
    if (!silent) toast(error.message || 'No se pudo consultar Google Calendar', 'err');
  }
}

async function createTask(payload) {
  try {
    await Tasks.create(payload);
    await reload();
    toast('Tarea creada');
  } catch { toast('No se pudo crear', 'err'); }
}

async function patchTask(id, patch, okMsg) {
  const syncKeys = ['title', 'scheduled_date', 'scheduled_time', 'duration_min', 'status', 'archived_at'];
  if (state.google.connected && !('sync_status' in patch) && syncKeys.some((key) => key in patch)) {
    patch = { ...patch, sync_status: 'pending' };
  }
  const t = state.tasks.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  paint();
  try {
    await Tasks.update(id, patch);
    if (okMsg) toast(okMsg);
  } catch { toast('No se pudo guardar', 'err'); reload(); }
}

async function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const done = t.status !== 'done';
  let timerElapsed = Number(t.timer_elapsed_sec || 0);
  if (t.timer_started_at) timerElapsed += Math.max(0, Math.floor((Date.now() - new Date(t.timer_started_at).getTime()) / 1000));
  await patchTask(id, {
    status: done ? 'done' : 'todo',
    completed_at: done ? new Date().toISOString() : null,
    actual_duration_min: done ? (timerElapsed ? Math.max(1, Math.round(timerElapsed / 60)) : Number(t.duration_min || 30)) : t.actual_duration_min,
    timer_started_at: null,
    timer_elapsed_sec: timerElapsed,
  }, done ? '¡Hecho! ✓' : null);
  if (done && t.recurrence_rule?.frequency && !state.tasks.some((x) => x.recurrence_parent_id === t.id)) {
    const next = nextRecurringDate(t.due_date || t.scheduled_date || todayISO(), t.recurrence_rule.frequency);
    const copy = { ...t };
    ['id', 'created_at', 'updated_at', 'completed_at', 'archived_at'].forEach((k) => delete copy[k]);
    await createTask({ ...copy, status: 'todo', due_date: t.due_date ? next : null,
      scheduled_date: null, scheduled_time: null, recurrence_parent_id: t.id,
      timer_started_at: null, timer_elapsed_sec: 0, actual_duration_min: null });
  }
}

function nextRecurringDate(from, frequency) {
  let next = addDays(from, frequency === 'weekly' ? 7 : 1);
  if (frequency === 'weekdays') while ([0, 6].includes(dateAt(next).getDay())) next = addDays(next, 1);
  if (frequency === 'monthly') {
    const d = dateAt(from); d.setMonth(d.getMonth() + 1); next = d.toLocaleDateString('en-CA');
  }
  return next;
}

function toggleTimer(task) {
  if (task.timer_started_at) {
    const extra = Math.max(0, Math.floor((Date.now() - new Date(task.timer_started_at).getTime()) / 1000));
    return patchTask(task.id, { timer_started_at: null, timer_elapsed_sec: Number(task.timer_elapsed_sec || 0) + extra }, 'Temporizador pausado');
  }
  return patchTask(task.id, { timer_started_at: new Date().toISOString(), status: task.status === 'done' ? 'todo' : 'doing' }, 'Temporizador iniciado');
}

function removeTask(id) {
  confirmSheet('Archivar tarea', 'Se ocultará sin borrar su historial.', async () => {
    await patchTask(id, { archived_at: new Date().toISOString() }, 'Tarea archivada');
  });
}

function taskSheet(task) {
  const isNew = !task;
  const t = task || {
    title: '', notes: '', due_date: '', duration_min: 30,
    project_id: '', urgent: false, important: false,
    notification_enabled: false, recurrence_rule: null,
  };

  sheet({
    title: isNew ? 'Nueva tarea' : 'Editar tarea',
    body: html`
      <div class="field"><label>¿Qué hay que hacer?</label>
        <input class="input" id="k-title" value="${t.title}" placeholder="Título de la tarea"></div>

      <div class="field"><label>Clasificación</label>
        <div class="row" style="gap:10px">
          <button class="tgFlag" type="button" id="k-urgent" aria-pressed="${t.urgent ? 'true' : 'false'}" style="flex:1">⚡ URGENTE</button>
          <button class="tgFlag" type="button" id="k-important" aria-pressed="${t.important ? 'true' : 'false'}" style="flex:1">◎ IMPORTANTE</button>
        </div></div>

      <div class="grid2">
        <div class="field"><label>Proyecto</label>
          <select class="select" id="k-proj">
            <option value="">Sin proyecto</option>
            ${raw(state.projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`).join(''))}
          </select></div>
        <div class="field"><label>Duración</label>
          <select class="select" id="k-dur">
            ${raw(DURATIONS.map((d) => `<option value="${d}" ${d === t.duration_min ? 'selected' : ''}>${fmtDuration(d)}</option>`).join(''))}
          </select></div>
      </div>

      <div class="field"><label>Fecha límite</label>
        <input class="input" id="k-due" type="date" value="${t.due_date || ''}"></div>

      <div class="grid2">
        <div class="field"><label>Repetición</label><select class="select" id="k-rec">
          <option value="none">No se repite</option>
          <option value="daily" ${t.recurrence_rule?.frequency === 'daily' ? 'selected' : ''}>Cada día</option>
          <option value="weekdays" ${t.recurrence_rule?.frequency === 'weekdays' ? 'selected' : ''}>Lunes a viernes</option>
          <option value="weekly" ${t.recurrence_rule?.frequency === 'weekly' ? 'selected' : ''}>Cada semana</option>
          <option value="monthly" ${t.recurrence_rule?.frequency === 'monthly' ? 'selected' : ''}>Cada mes</option>
        </select></div>
        <div class="field"><label>Avisos</label><label class="tgInlineCheck"><input id="k-notify" type="checkbox" ${t.notification_enabled ? 'checked' : ''}> Notificar al acercarse la fecha</label></div>
      </div>

      <div class="field"><label>Notas</label>
        <textarea class="textarea" id="k-notes" placeholder="Detalles, links, lo que sea">${t.notes || ''}</textarea></div>`,
    actions: [
      ...(isNew ? [] : [{ label: 'Archivar', variant: 'danger', onClick: ({ close }) => { close(); removeTask(t.id); } }]),
      {
        label: isNew ? 'Agregar a la matriz' : 'Guardar',
        variant: 'primary',
        onClick: async ({ close, root: r }) => {
          const title = $('#k-title', r).value.trim();
          if (!title) return toast('Ponle un título', 'err');
          const recurrence = $('#k-rec', r).value;
          const patch = {
            title,
            urgent: $('#k-urgent', r).getAttribute('aria-pressed') === 'true',
            important: $('#k-important', r).getAttribute('aria-pressed') === 'true',
            classified: true,
            project_id: $('#k-proj', r).value || null,
            duration_min: Number($('#k-dur', r).value),
            due_date: $('#k-due', r).value || null,
            recurrence_rule: recurrence === 'none' ? null : { frequency: recurrence },
            notification_enabled: $('#k-notify', r).checked,
            notes: $('#k-notes', r).value,
          };
          close();
          if (isNew) await createTask({ ...patch, profile_id: perfilActivo()?.id || null, status: 'todo' });
          else await patchTask(t.id, patch, 'Guardado');
        },
      },
    ],
    onOpen: ({ root: r }) => {
      ['#k-urgent', '#k-important'].forEach((sel) => {
        $(sel, r).addEventListener('click', (e) => {
          const b = e.currentTarget;
          b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
        });
      });
    },
  });
}

function scheduleSheet(task) {
  sheet({
    title: 'Llevar a la agenda',
    body: html`
      <p class="sheetText"><b>${task.title}</b></p>
      <div class="grid2">
        <div class="field"><label>Día</label>
          <input class="input" id="s-date" type="date" value="${task.scheduled_date || todayISO()}"></div>
        <div class="field"><label>Hora</label>
          <input class="input" id="s-time" type="time" step="1800" value="${(task.scheduled_time || '09:00').slice(0, 5)}"></div>
      </div>
      <div class="field"><label>Duración</label>
        <select class="select" id="s-dur">
          ${raw(DURATIONS.map((d) => `<option value="${d}" ${d === task.duration_min ? 'selected' : ''}>${fmtDuration(d)}</option>`).join(''))}
        </select></div>`,
    actions: [
      ...(task.scheduled_date ? [{
        label: 'Quitar de la agenda',
        onClick: ({ close }) => {
          close();
          patchTask(task.id, { scheduled_date: null, scheduled_time: null, reschedule_count: Number(task.reschedule_count || 0) + 1 }, 'Fuera de la agenda');
        },
      }] : []),
      {
        label: 'Agendar', variant: 'primary',
        onClick: ({ close, root: r }) => {
          const date = $('#s-date', r).value;
          const time = $('#s-time', r).value;
          if (!date || !time) return toast('Elige día y hora', 'err');
          close();
          patchTask(task.id, {
            scheduled_date: date, scheduled_time: time,
            duration_min: Number($('#s-dur', r).value),
            reschedule_count: Number(task.reschedule_count || 0) + (task.scheduled_date && (task.scheduled_date !== date || task.scheduled_time?.slice(0, 5) !== time) ? 1 : 0),
          }, 'Agendada ✓');
        },
      },
    ],
  });
}

function eventSheet(ev, occurrenceDate = ev?.event_date) {
  const isNew = !ev;
  const e = ev || { title: '', event_date: todayISO(), start_time: '09:00', end_time: '10:00', color: '#42a5ff', recurrence: 'none', repeat_until: '' };
  sheet({
    title: isNew ? 'Nuevo compromiso' : 'Editar compromiso',
    body: html`
      <div class="field"><label>Nombre</label>
        <input class="input" id="e-title" value="${e.title}" placeholder="Ej. Dead Camera"></div>
      <div class="field"><label>Fecha</label>
        <input class="input" id="e-date" type="date" value="${occurrenceDate || e.event_date}"></div>
      <div class="grid2">
        <div class="field"><label>Desde</label>
          <input class="input" id="e-start" type="time" step="1800" value="${(e.start_time || '').slice(0, 5)}"></div>
        <div class="field"><label>Hasta</label>
          <input class="input" id="e-end" type="time" step="1800" value="${(e.end_time || '').slice(0, 5)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Se repite</label>
          <select class="select" id="e-rec">
            <option value="none" ${e.recurrence === 'none' ? 'selected' : ''}>No se repite</option>
            <option value="daily" ${e.recurrence === 'daily' ? 'selected' : ''}>Cada día</option>
            <option value="weekdays" ${e.recurrence === 'weekdays' ? 'selected' : ''}>Lunes a viernes</option>
            <option value="weekly" ${e.recurrence === 'weekly' ? 'selected' : ''}>Cada semana</option>
            <option value="monthly" ${e.recurrence === 'monthly' ? 'selected' : ''}>Cada mes</option>
          </select></div>
        <div class="field"><label>Color</label>
          <input class="input" id="e-color" type="color" value="${e.color}" style="height:48px;padding:4px"></div>
      </div>
      <div class="field"><label>Repetir hasta (opcional)</label>
        <input class="input" id="e-until" type="date" value="${e.repeat_until || ''}"></div>
      ${raw(!isNew && e.recurrence !== 'none' ? `<div class="field"><label>Aplicar cambio</label><select class="select" id="e-scope"><option value="this">Solo esta fecha (${esc(occurrenceDate)})</option><option value="future">Esta y las futuras</option><option value="all">Toda la serie</option></select></div>` : '')}
      <label class="tgInlineCheck"><input id="e-notify" type="checkbox" ${e.notification_enabled ? 'checked' : ''}> Notificar antes del compromiso</label>`,
    actions: [
      ...(isNew ? [] : [{
        label: 'Archivar', variant: 'danger',
        onClick: ({ close }) => {
          close();
          confirmSheet('Archivar compromiso', 'Se ocultará sin borrar su historial.', async () => {
            try { await Agenda.update(e.id, { archived_at: new Date().toISOString(), ...(state.google.connected ? { sync_status: 'pending' } : {}) }); await reload(); toast('Archivado'); }
            catch { toast('No se pudo archivar', 'err'); }
          });
        },
      }]),
      {
        label: isNew ? 'Crear' : 'Guardar', variant: 'primary',
        onClick: async ({ close, root: r }) => {
          const payload = {
            title: $('#e-title', r).value.trim(),
            event_date: $('#e-date', r).value,
            start_time: $('#e-start', r).value,
            end_time: $('#e-end', r).value,
            recurrence: $('#e-rec', r).value,
            color: $('#e-color', r).value,
            repeat_until: $('#e-until', r).value || null,
            notification_enabled: $('#e-notify', r).checked,
            ...(!isNew && state.google.connected ? { sync_status: 'pending' } : {}),
          };
          if (!payload.title || !payload.event_date) return toast('Falta el nombre o la fecha', 'err');
          if (minutesOf(payload.end_time) <= minutesOf(payload.start_time)) return toast('La hora final debe ir después', 'err');
          close();
          try {
            if (isNew) await Agenda.create({ ...payload, profile_id: perfilActivo()?.id || null });
            else if (e.recurrence !== 'none' && $('#e-scope', r)?.value === 'this') {
              const exceptions = [...(e.recurrence_exceptions || []), { date: occurrenceDate, cancelled: true }];
              await Agenda.update(e.id, { recurrence_exceptions: exceptions, ...(state.google.connected ? { sync_status: 'pending' } : {}) });
              await Agenda.create({ ...payload, event_date: occurrenceDate, recurrence: 'none', repeat_until: null, profile_id: perfilActivo()?.id || null });
            } else {
              if ($('#e-scope', r)?.value === 'future') payload.event_date = occurrenceDate;
              if ($('#e-scope', r)?.value === 'all' && payload.event_date === occurrenceDate) payload.event_date = e.event_date;
              await Agenda.update(e.id, payload);
            }
            await reload();
            toast(isNew ? 'Compromiso creado' : 'Guardado');
          } catch { toast('No se pudo guardar', 'err'); }
        },
      },
    ],
  });
}

function projectSheet(proj) {
  const isNew = !proj;
  const p = proj || { name: '', emoji: '📁', color: '#ffd523', image_url: '' };
  sheet({
    title: isNew ? 'Nuevo proyecto' : 'Editar proyecto',
    body: html`
      <div class="field"><label>Nombre</label>
        <input class="input" id="p-name" value="${p.name}" placeholder="Ej. SINCERICIDIO"></div>
      <div class="grid2">
        <div class="field"><label>Emoji</label><input class="input" id="p-emoji" value="${p.emoji}" maxlength="4"></div>
        <div class="field"><label>Color</label><input class="input" id="p-color" type="color" value="${p.color}" style="height:48px;padding:4px"></div>
      </div>
      <div class="field"><label>Imagen (enlace)</label>
        <input class="input" id="p-img" value="${p.image_url || ''}" placeholder="https://…"></div>`,
    actions: [
      ...(isNew ? [] : [{
        label: 'Archivar', variant: 'danger',
        onClick: ({ close }) => {
          close();
          confirmSheet('Archivar proyecto', 'Las tareas y el historial se conservan.', async () => {
            try { await Projects.update(p.id, { archived: true }); await reload(); toast('Proyecto archivado'); }
            catch { toast('No se pudo archivar', 'err'); }
          });
        },
      }]),
      {
        label: isNew ? 'Crear' : 'Guardar', variant: 'primary',
        onClick: async ({ close, root: r }) => {
          const payload = {
            name: $('#p-name', r).value.trim(),
            emoji: $('#p-emoji', r).value || '📁',
            color: $('#p-color', r).value,
            image_url: $('#p-img', r).value.trim() || null,
          };
          if (!payload.name) return toast('Ponle un nombre', 'err');
          close();
          try {
            if (isNew) await Projects.create({ ...payload, profile_id: perfilActivo()?.id || null, sort_order: state.projects.length + 1 });
            else await Projects.update(p.id, payload);
            await reload();
            toast(isNew ? 'Proyecto creado' : 'Guardado');
          } catch { toast('No se pudo guardar', 'err'); }
        },
      },
    ],
  });
}

function noteSheet(note) {
  sheet({
    title: 'Aviso del recordatorio',
    body: html`
      <p class="sheetText"><b>${note.body}</b></p>
      <div class="field"><label>Fecha y hora (opcional)</label><input class="input" id="n-remind" type="datetime-local" value="${note.remind_at ? note.remind_at.slice(0, 16) : ''}"></div>
      <label class="tgInlineCheck"><input id="n-notify" type="checkbox" ${note.notification_enabled ? 'checked' : ''}> Mostrar notificación</label>`,
    actions: [{
      label: 'Guardar aviso', variant: 'primary',
      onClick: async ({ close, root: r }) => {
        const local = $('#n-remind', r).value;
        close();
        try {
          await Notes.update(note.id, { remind_at: local ? new Date(local).toISOString() : null, notification_enabled: $('#n-notify', r).checked });
          await reload();
          toast('Aviso guardado');
        } catch { toast('No se pudo guardar', 'err'); }
      },
    }],
  });
}

function checkNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const upcoming = [
    ...state.notes.filter((n) => n.notification_enabled && n.remind_at).map((n) => ({ id: `n:${n.id}:${n.remind_at}`, title: 'Recordatorio', body: n.body, at: new Date(n.remind_at).getTime() })),
    ...pending().filter((t) => t.notification_enabled && t.scheduled_date && t.scheduled_time).map((t) => ({ id: `t:${t.id}:${t.scheduled_date}:${t.scheduled_time}`, title: 'Tarea próxima', body: t.title, at: new Date(`${t.scheduled_date}T${t.scheduled_time}`).getTime() })),
  ];
  upcoming.filter((x) => x.at <= now + 15 * 60e3 && x.at >= now - 60e3).forEach((x) => {
    const key = `ashub:notified:${x.id}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    new Notification(x.title, { body: x.body, icon: '/icons/icon-192.png', tag: x.id });
  });
}

export async function render(container) {
  root = container;
  document.body.dataset.skin = 'taskgrid';
  state.section = sectionFromHash();

  const cache = readCache(`tgModule:${perfilActivo()?.id || 'legacy'}`);
  if (cache) state = { ...state, ...cache };
  if (!state.weekStart) state.weekStart = startOfWeek(todayISO());

  root.innerHTML = html`
    <div class="tg">
      <aside class="tgSide">
        <div class="tgLogo">
          <i>AS</i>
          <div><b>TASK//GRID</b><small>PERSONAL OPS</small></div>
        </div>
        <nav class="tgNav">
          ${raw(SECTIONS.map((s) => `
            <a href="${routeFor(s.id)}" data-section="${s.id}" aria-current="${s.id === state.section}">
              <span>${s.icon}</span>${esc(s.label)}
            </a>`).join(''))}
        </nav>
        <div class="tgSync">
          <b>◍ SINCRONIZADO · TODOS TUS DISPOSITIVOS</b>
          <small>PC + MOBILE</small>
        </div>
      </aside>
      <div class="tgMain" id="tgMain"></div>
    </div>
    <button class="tgTaskFab" id="tgTaskFab" type="button" aria-label="Nueva tarea">＋</button>`;

  paint();
  await reload({ silent: true });
  if (state.section === 'agenda') {
    const googleResult = new URLSearchParams((location.hash.split('?')[1] || '')).get('google');
    if (googleResult === 'connected') toast('Google Calendar conectado');
    if (googleResult === 'denied') toast('No se concedió acceso a Google Calendar', 'info');
    if (googleResult) history.replaceState(null, '', `${location.pathname}${location.search}#/tareas/agenda`);
    await loadGoogleStatus({ silent: true });
  }

  $('.tgNav', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-section]');
    if (!b) return;
    state.section = b.dataset.section;
    state.picked = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#tgTaskFab', root).addEventListener('click', () => taskSheet(null));

  const main = $('#tgMain', root);

  main.addEventListener('submit', (e) => {
    if (e.target.id === 'tgCapture') {
      e.preventDefault();
      const input = $('#tgCaptureInput', main);
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      createTask({
        title, status: 'todo', classified: true,
        urgent: state.capture.urgent, important: state.capture.important,
        duration_min: 30, profile_id: perfilActivo()?.id || null,
      });
      state.capture = { urgent: false, important: false };
    }
    if (e.target.id === 'tgNoteNew') {
      e.preventDefault();
      const ta = $('#tgNoteInput', main);
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      Notes.create({ body, color: NOTE_COLORS[state.notes.length % NOTE_COLORS.length], profile_id: perfilActivo()?.id || null })
        .then(() => reload()).catch(() => toast('No se pudo pegar la nota', 'err'));
    }
  });

  main.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;

    const flag = e.target.closest('[data-flag]');
    if (flag) {
      const k = flag.dataset.flag;
      state.capture[k] = !state.capture[k];
      flag.setAttribute('aria-pressed', String(state.capture[k]));
      return;
    }

    if (act === 'newtask') return taskSheet(null);
    if (act === 'newevent') return eventSheet(null);
    if (act === 'newproj') return projectSheet(null);
    if (act === 'clearfilter') { state.projectFilter = null; return paint(); }
    if (act === 'prevweek') { state.weekStart = addDays(state.weekStart, -7); return paint(); }
    if (act === 'nextweek') { state.weekStart = addDays(state.weekStart, 7); return paint(); }
    if (act === 'todayweek') { state.weekStart = startOfWeek(todayISO()); return paint(); }
    if (act === 'calendar-info') return toast('Añade GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en los secretos de Edge Functions. Redirect URI: ' + `${SUPABASE_URL}/functions/v1/google-calendar`, 'info');
    if (act === 'calendar-connect') {
      state.google.loading = true; paint();
      return googleRequest('start').then((result) => { location.assign(result.authorization_url); })
        .catch((error) => { state.google.loading = false; paint(); toast(error.message, 'err'); });
    }
    if (act === 'calendar-sync') {
      state.google.loading = true; paint();
      return googleRequest('sync').then(async (result) => {
        toast(`Google: ${result.pulled} importados · ${result.pushed} publicados${result.conflicts ? ` · ${result.conflicts} conflictos` : ''}`);
        await reload(); await loadGoogleStatus({ silent: true });
      }).catch((error) => { state.google.loading = false; paint(); toast(error.message, 'err'); });
    }
    if (act === 'calendar-disconnect') {
      return confirmSheet('Desconectar Google Calendar', 'Se revocará el token y AS Hub dejará de sincronizar.', async () => {
        try { await googleRequest('disconnect'); state.google = { loading: false, connected: false, configured: true, connection: null }; paint(); toast('Google Calendar desconectado'); }
        catch (error) { toast(error.message, 'err'); }
      });
    }
    if (act === 'notifications') {
      if (!('Notification' in window)) return toast('Este navegador no admite notificaciones', 'err');
      Notification.requestPermission().then((permission) => {
        toast(permission === 'granted' ? 'Notificaciones activadas' : 'Permiso no concedido', permission === 'granted' ? 'ok' : 'info');
        checkNotifications();
      });
      return;
    }
    if (act === 'accept-suggestion') {
      const task = state.tasks.find((t) => t.id === actEl.dataset.id);
      if (!task) return;
      return patchTask(task.id, { scheduled_date: actEl.dataset.date, scheduled_time: actEl.dataset.time,
        reschedule_count: Number(task.reschedule_count || 0) + (task.scheduled_date ? 1 : 0) }, 'Sugerencia agendada');
    }
    if (act === 'do-now') {
      const task = state.tasks.find((t) => t.id === actEl.dataset.id);
      if (task) return toggleTimer(task);
    }
    if (act?.startsWith('missed-')) {
      const task = state.tasks.find((t) => t.id === actEl.dataset.id);
      if (!task) return;
      if (act === 'missed-reschedule') return scheduleSheet(task);
      if (act === 'missed-complete') return toggleTask(task.id);
      return patchTask(task.id, { scheduled_date: null, scheduled_time: null, reschedule_count: Number(task.reschedule_count || 0) + 1 }, 'Quedó pendiente');
    }
    if (act === 'schedule' && actEl.dataset.taskId) {
      const task = state.tasks.find((t) => t.id === actEl.dataset.taskId);
      if (task) return scheduleSheet(task);
    }

    const projEl = e.target.closest('[data-proj]');
    if (projEl && (act === 'openproj' || act === 'editproj')) {
      const p = projectOf(projEl.dataset.proj);
      if (act === 'editproj') return projectSheet(p);
      state.projectFilter = p.id;
      location.hash = '/tareas/pendientes';
      state.section = 'tareas'; return paint();
    }

    const noteEl = e.target.closest('[data-note]');
    if (noteEl) {
      const id = noteEl.dataset.note;
      const note = state.notes.find((n) => n.id === id);
      if (act === 'notedel') {
        return confirmSheet('Archivar nota', 'Se ocultará sin borrar su historial.', async () => {
          state.notes = state.notes.filter((n) => n.id !== id); paint();
          try { await Notes.update(id, { status: 'done' }); } catch { toast('No se pudo archivar', 'err'); }
        });
      }
      if (act === 'editnote') return noteSheet(note);
      if (act === 'review') {
        note.reviewed = !note.reviewed;
        actEl.setAttribute('aria-pressed', String(note.reviewed));
        Notes.update(id, { reviewed: note.reviewed }).catch(() => toast('Error', 'err'));
        return;
      }
    }

    const evEl = e.target.closest('[data-event]');
    if (evEl) {
      const ev = state.events.find((x) => x.id === evEl.dataset.event);
      if (act === 'pickevent' && ev) {
        state.picked = { kind: 'event', id: ev.id };
        toast('Ahora toca una casilla de la agenda'); return;
      }
      if (ev) return eventSheet(ev, evEl.dataset.date || ev.event_date);
    }

    const slot = e.target.closest('.tgSlot');
    if (slot && state.picked && !e.target.closest('[data-task]')) {
      const item = state.picked;
      state.picked = null;
      if (item.kind === 'event') {
        const ev = state.events.find((x) => x.id === item.id);
        const duration = minutesOf(ev.end_time) - minutesOf(ev.start_time);
        return Agenda.update(ev.id, { event_date: slot.dataset.date, start_time: slot.dataset.time,
          end_time: timeFromMinutes(minutesOf(slot.dataset.time) + duration), ...(state.google.connected ? { sync_status: 'pending' } : {}) }).then(() => reload()).then(() => toast('Compromiso movido'));
      }
      const task = state.tasks.find((t) => t.id === item.id);
      return patchTask(item.id, { scheduled_date: slot.dataset.date, scheduled_time: slot.dataset.time,
        reschedule_count: Number(task?.reschedule_count || 0) + (task?.scheduled_date ? 1 : 0) }, 'Agendada ✓');
    }

    const taskEl = e.target.closest('[data-task]');
    if (!taskEl) return;
    const task = state.tasks.find((t) => t.id === taskEl.dataset.task);
    if (!task) return;
    if (act === 'toggle') return toggleTask(task.id);
    if (act === 'del') return removeTask(task.id);
    if (act === 'edit') return taskSheet(task);
    if (act === 'schedule') return scheduleSheet(task);
    if (act === 'timer') return toggleTimer(task);
    if (act === 'shrink' || act === 'grow') {
      const duration = Math.max(30, Math.min(240, Number(task.duration_min || 30) + (act === 'grow' ? 30 : -30)));
      return patchTask(task.id, { duration_min: duration }, `Duración: ${fmtDuration(duration)}`);
    }

    if (taskEl.closest('.tgEvent--task')) {
      state.picked = state.picked?.id === task.id ? null : { kind: 'task', id: task.id };
      paint();
      if (state.picked) toast('Ahora toca otra casilla de la agenda');
      return;
    }

    if (taskEl.closest('.tgDragBody')) {
      state.picked = state.picked?.id === task.id ? null : { kind: 'task', id: task.id };
      paint();
      if (state.picked) toast('Ahora toca una casilla de la agenda');
    }
  });

  let noteTimer;
  main.addEventListener('input', (e) => {
    if (e.target.id === 'tgPreferredPeriod') {
      state.preferredPeriod = e.target.value;
      localStorage.setItem('ashub:tasks:preferred-period', state.preferredPeriod);
      return paint();
    }
    if (e.target.id === 'tgNoteSearch') {
      state.noteQuery = e.target.value;
      const query = state.noteQuery.trim().toLocaleLowerCase('es');
      $$('.tgNote', main).forEach((note) => { note.hidden = !!query && !$('textarea', note).value.toLocaleLowerCase('es').includes(query); });
      return;
    }
    const ta = e.target.closest('[data-act="notebody"]');
    if (!ta) return;
    autosize(ta);
    const id = ta.closest('[data-note]').dataset.note;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      const note = state.notes.find((n) => n.id === id);
      if (note) note.body = ta.value;
      try { await Notes.update(id, { body: ta.value }); } catch { toast('No se guardó la nota', 'err'); }
    }, 700);
  });

  let dragItem = null;
  main.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[draggable="true"][data-task], [draggable="true"][data-event]');
    if (!el) return;
    dragItem = { kind: el.dataset.task ? 'task' : 'event', id: el.dataset.task || el.dataset.event };
    el.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragItem.id);
  });
  main.addEventListener('dragend', () => {
    dragItem = null;
    $$('.is-dragging', main).forEach((el) => el.classList.remove('is-dragging'));
  });
  main.addEventListener('dragover', (e) => {
    const slot = e.target.closest('.tgSlot');
    if (!slot || !dragItem) return;
    e.preventDefault();
    slot.classList.add('is-drop');
  });
  main.addEventListener('dragleave', (e) => {
    e.target.closest('.tgSlot')?.classList.remove('is-drop');
  });
  main.addEventListener('drop', (e) => {
    const slot = e.target.closest('.tgSlot');
    if (!slot || !dragItem) return;
    e.preventDefault();
    slot.classList.remove('is-drop');
    const item = dragItem;
    dragItem = null;
    if (item.kind === 'task') {
      const task = state.tasks.find((t) => t.id === item.id);
      patchTask(item.id, { scheduled_date: slot.dataset.date, scheduled_time: slot.dataset.time,
        reschedule_count: Number(task?.reschedule_count || 0) + (task?.scheduled_date ? 1 : 0) }, 'Agendada ✓');
    } else {
      const ev = state.events.find((x) => x.id === item.id);
      if (!ev) return;
      const duration = minutesOf(ev.end_time) - minutesOf(ev.start_time);
      Agenda.update(item.id, { event_date: slot.dataset.date, start_time: slot.dataset.time,
        end_time: timeFromMinutes(minutesOf(slot.dataset.time) + duration), ...(state.google.connected ? { sync_status: 'pending' } : {}) }).then(() => reload()).then(() => toast('Compromiso movido')).catch(() => toast('No se pudo mover', 'err'));
    }
  });

  watch('tasks', ['tasks', 'task_projects', 'notes', 'agenda_events'], () => {
    if (document.activeElement?.dataset?.act === 'notebody') return;
    reload({ silent: true });
  });
  state.nowTimer = setInterval(() => { checkNotifications(); if (state.tasks.some((t) => t.timer_started_at)) paint(); }, 60000);
  checkNotifications();
}

export function destroy() {
  unwatch('tasks');
  clearInterval(state.nowTimer);
  state.nowTimer = null;
  delete document.body.dataset.skin;
}
