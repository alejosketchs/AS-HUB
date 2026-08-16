// AS HUB — TASK//GRID (módulo de Tareas)
// Copia servida desde el espejo: resuelve sus dependencias contra el sitio
// que la está usando, así comparte la misma instancia de datos que el resto.
const { Tasks, Projects, Notes, Agenda, watch, unwatch, readCache, writeCache } =
  await import(new URL('/js/db.js', location.origin).href);
const { $, $$, html, raw, esc, toast, sheet, confirmSheet, todayISO, addDays } =
  await import(new URL('/js/ui.js', location.origin).href);

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
  { id: 'tareas', icon: ICONS.grid, label: 'Tareas' },
  { id: 'hoy', icon: ICONS.today, label: 'Hoy' },
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

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];
const NOTE_COLORS = ['#ffd523', '#a8ff1e', '#8bd8ff', '#ff9ecb', '#d5b8ff', '#ffb37a'];

const DIAS_LARGOS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
const DIAS_CORTOS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const SLOT_H = 34;
const DAY_START = 6;
const DAY_END = 22;

let root;
let state = {
  section: 'tareas',
  weekStart: null,
  projectFilter: null,
  capture: { urgent: false, important: false },
  picked: null,
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
const pending = () => state.tasks.filter((t) => t.status !== 'done');

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
  if (!mini && t.scheduled_date) {
    chips.push(`<span class="tgChip">▤ ${esc(t.scheduled_date)} · ${esc(fmtTime(t.scheduled_time))}</span>`);
  }

  return html`
    <article class="tgTask ${mini ? 'tgTask--mini' : ''} ${t.status === 'done' ? 'is-done' : ''} ${state.picked === t.id ? 'is-picked' : ''}"
             data-task="${t.id}" style="--qe:${q ? `var(--q${q}-edge)` : '#8a8a80'}"
             ${raw(draggable ? 'draggable="true"' : '')}>
      <div class="tgTaskTop">
        <button class="tgCheck" type="button" data-act="toggle" aria-label="Completar">✓</button>
        <div class="tgTaskTitle">${t.title}</div>
        <div class="tgIcons">
          <button type="button" data-act="edit" aria-label="Editar">✎</button>
          <button type="button" data-act="del" aria-label="Borrar">🗑</button>
        </div>
      </div>
      <div class="tgTaskMeta">${meta.join(' · ')}</div>
      <div class="tgChips">${raw(chips.join(''))}</div>
      ${raw(mini ? '' : '<button class="tgLink" type="button" data-act="schedule">→ Llevar a agenda</button>')}
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

    <section class="tgCapture">
      <span>// CAPTURA + CLASIFICA</span>
      <h3>NUEVA TAREA</h3>
      <p>Elige urgencia e importancia; aparecerá abajo en su cuadrante.</p>
      <form class="tgCaptureBar" id="tgCapture">
        <input id="tgCaptureInput" placeholder="＋  ¿Qué necesitas hacer?" autocomplete="off">
        <button class="tgFlag" type="button" data-flag="urgent" aria-pressed="${state.capture.urgent ? 'true' : 'false'}">⚡ URGENTE</button>
        <button class="tgFlag" type="button" data-flag="important" aria-pressed="${state.capture.important ? 'true' : 'false'}">◎ IMPORTANTE</button>
        <button class="tgBtn tgBtn--ink tgBtn--sm" type="submit">AGREGAR A LA MATRIZ</button>
      </form>
    </section>

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
  const vencen = pending().filter((t) => t.due_date === today);
  const vencidas = pending().filter((t) => t.due_date && t.due_date < today);

  const timeline = items.length ? html`<div class="tgTimeline">${raw(items.map((it) => `
    <div class="tgTimeItem" style="background:${it.kind === 'task' ? `var(--q${it.quad || 4})` : 'var(--q2)'}">
      <b>${esc(fmtTime(it.start))}</b>
      <span>${esc(it.title)}</span>
      <b style="width:auto;color:#57574f">${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</b>
    </div>`).join(''))}</div>`
    : '<div class="tgQuadEmpty">Hoy no tienes nada agendado.</div>';

  const listOf = (list, empty) => (list.length
    ? `<div class="tgQuadList">${list.map((t) => taskCardHTML(t)).join('')}</div>`
    : `<div class="tgQuadEmpty">${empty}</div>`);

  return html`
    ${raw(statsHTML())}
    <div class="tgToday">
      <div class="tgCard">
        <h4>TU DÍA, HORA POR HORA</h4>
        <p>Compromisos fijos y tareas que ya llevaste a la agenda.</p>
        ${raw(timeline)}
      </div>
      <div class="tgCard">
        <h4>VENCEN HOY</h4>
        <p>Tareas cuyo límite es hoy.</p>
        ${raw(listOf(vencen, 'Nada vence hoy.'))}
        <h4 style="margin-top:26px">SE TE PASARON</h4>
        <p>Límite ya cumplido y siguen abiertas.</p>
        ${raw(listOf(vencidas, 'Ninguna vencida. Impecable.'))}
      </div>
    </div>`;
}

function dayItems(iso) {
  const dow = dateAt(iso).getDay();
  const out = [];

  state.events.forEach((e) => {
    let applies = false;
    if (e.recurrence === 'none') applies = e.event_date === iso;
    else if (iso >= e.event_date && (!e.repeat_until || iso <= e.repeat_until)) {
      if (e.recurrence === 'weekdays') applies = dow >= 1 && dow <= 5;
      else if (e.recurrence === 'weekly') applies = dateAt(e.event_date).getDay() === dow;
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
          return `<div class="tgEvent" data-event="${it.id}" style="height:${h}px;border-left-color:${esc(it.color)}">
            <small>${esc(fmtTime(it.start))} → ${esc(fmtTime(it.end))}</small>
            <b>${esc(it.title)}</b>
            <i>${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</i>
          </div>`;
        }
        return `<div class="tgEvent tgEvent--task q${it.quad || 4} ${it.done ? 'is-done' : ''}"
                     data-task="${it.id}" data-act="edit" style="height:${h}px">
          <button class="tgEventDone" type="button" data-act="toggle" aria-label="Completar">✓</button>
          <small>${esc(fmtTime(it.start))}</small>
          <b>${esc(it.title)}</b>
          <i>${esc(fmtDuration(minutesOf(it.end) - minutesOf(it.start)))}</i>
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
    </div>`;
}

function viewProyectos() {
  const cards = state.projects.map((p) => {
    const all = state.tasks.filter((t) => t.project_id === p.id);
    const open = all.filter((t) => t.status !== 'done');
    const avatar = p.image_url
      ? `<img src="${esc(p.image_url)}" alt="">`
      : esc((p.name || '?').trim().charAt(0).toUpperCase());
    return html`
      <article class="tgProj" data-proj="${p.id}" style="--pc:${p.color}">
        <div class="tgProjTop">
          <div class="tgAvatar">${raw(avatar)}</div>
          <div class="tgProjName">
            <b>${p.name}</b>
            <small>${String(open.length)} ${open.length === 1 ? 'pendiente' : 'pendientes'}</small>
          </div>
          <div class="tgProjActions">
            <button class="tgBtn tgBtn--sm tgProjOpen" type="button" data-act="openproj">Abrir</button>
            <button class="tgBtn tgBtn--sm" type="button" data-act="editproj">✎ Editar</button>
          </div>
        </div>
        <details class="tgProjBody">
          <summary>▶ Ver tareas <span class="tgBadge">${String(open.length)}</span></summary>
          ${raw(open.length
            ? `<div class="tgProjTasks">${open.map((t) => taskCardHTML(t)).join('')}</div>`
            : '<div class="tgQuadEmpty">Este proyecto no tiene pendientes.</div>')}
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
  const notes = state.notes.map((n) => html`
    <article class="tgNote" data-note="${n.id}" style="background:${n.color}">
      <textarea data-act="notebody" placeholder="Escribe…">${n.body}</textarea>
      <div class="tgNoteFoot">
        <button class="tgReviewed" type="button" data-act="review" aria-pressed="${n.reviewed ? 'true' : 'false'}">Revisado</button>
        <button class="tgNoteX" type="button" data-act="notedel" aria-label="Borrar">✕</button>
      </div>
    </article>`).join('');

  return html`
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

  $$('.tgNav button', root).forEach((b) => {
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
    state = { ...state, tasks, projects, notes, events };
    writeCache('tgModule', { tasks, projects, notes, events });
    paint();
  } catch {
    if (!silent) toast('Sin conexión: viendo la última copia', 'info');
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
  const t = state.tasks.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  paint();
  try {
    await Tasks.update(id, patch);
    if (okMsg) toast(okMsg);
  } catch { toast('No se pudo guardar', 'err'); reload(); }
}

function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const done = t.status !== 'done';
  patchTask(id, {
    status: done ? 'done' : 'todo',
    completed_at: done ? new Date().toISOString() : null,
  }, done ? '¡Hecho! ✓' : null);
}

function removeTask(id) {
  confirmSheet('Borrar tarea', '¿Seguro? Esto no se puede deshacer.', async () => {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    paint();
    try { await Tasks.remove(id); toast('Borrada'); }
    catch { toast('No se pudo borrar', 'err'); reload(); }
  });
}

function taskSheet(task) {
  const isNew = !task;
  const t = task || {
    title: '', notes: '', due_date: '', duration_min: 30,
    project_id: '', urgent: false, important: false,
    scheduled_date: '', scheduled_time: '',
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
        <div class="field"><label>Agendar el día</label>
          <input class="input" id="k-sdate" type="date" value="${t.scheduled_date || ''}"></div>
        <div class="field"><label>A las</label>
          <input class="input" id="k-stime" type="time" step="1800" value="${(t.scheduled_time || '').slice(0, 5)}"></div>
      </div>

      <div class="field"><label>Notas</label>
        <textarea class="textarea" id="k-notes" placeholder="Detalles, links, lo que sea">${t.notes || ''}</textarea></div>`,
    actions: [
      ...(isNew ? [] : [{ label: 'Borrar', variant: 'danger', onClick: ({ close }) => { close(); removeTask(t.id); } }]),
      {
        label: isNew ? 'Agregar a la matriz' : 'Guardar',
        variant: 'primary',
        onClick: async ({ close, root: r }) => {
          const title = $('#k-title', r).value.trim();
          if (!title) return toast('Ponle un título', 'err');
          const sdate = $('#k-sdate', r).value || null;
          const stime = $('#k-stime', r).value || null;
          const patch = {
            title,
            urgent: $('#k-urgent', r).getAttribute('aria-pressed') === 'true',
            important: $('#k-important', r).getAttribute('aria-pressed') === 'true',
            classified: true,
            project_id: $('#k-proj', r).value || null,
            duration_min: Number($('#k-dur', r).value),
            due_date: $('#k-due', r).value || null,
            scheduled_date: sdate && stime ? sdate : null,
            scheduled_time: sdate && stime ? stime : null,
            notes: $('#k-notes', r).value,
          };
          close();
          if (isNew) await createTask({ ...patch, status: 'todo' });
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
          patchTask(task.id, { scheduled_date: null, scheduled_time: null }, 'Fuera de la agenda');
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
          }, 'Agendada ✓');
        },
      },
    ],
  });
}

function eventSheet(ev) {
  const isNew = !ev;
  const e = ev || { title: '', event_date: todayISO(), start_time: '09:00', end_time: '10:00', color: '#42a5ff', recurrence: 'none', repeat_until: '' };
  sheet({
    title: isNew ? 'Nuevo compromiso' : 'Editar compromiso',
    body: html`
      <div class="field"><label>Nombre</label>
        <input class="input" id="e-title" value="${e.title}" placeholder="Ej. Dead Camera"></div>
      <div class="field"><label>Fecha</label>
        <input class="input" id="e-date" type="date" value="${e.event_date}"></div>
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
            <option value="weekdays" ${e.recurrence === 'weekdays' ? 'selected' : ''}>Lunes a viernes</option>
            <option value="weekly" ${e.recurrence === 'weekly' ? 'selected' : ''}>Cada semana</option>
          </select></div>
        <div class="field"><label>Color</label>
          <input class="input" id="e-color" type="color" value="${e.color}" style="height:48px;padding:4px"></div>
      </div>
      <div class="field"><label>Repetir hasta (opcional)</label>
        <input class="input" id="e-until" type="date" value="${e.repeat_until || ''}"></div>`,
    actions: [
      ...(isNew ? [] : [{
        label: 'Borrar', variant: 'danger',
        onClick: ({ close }) => {
          close();
          confirmSheet('Borrar compromiso', '¿Seguro?', async () => {
            try { await Agenda.remove(e.id); await reload(); toast('Borrado'); }
            catch { toast('No se pudo borrar', 'err'); }
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
          };
          if (!payload.title || !payload.event_date) return toast('Falta el nombre o la fecha', 'err');
          if (minutesOf(payload.end_time) <= minutesOf(payload.start_time)) return toast('La hora final debe ir después', 'err');
          close();
          try {
            if (isNew) await Agenda.create(payload);
            else await Agenda.update(e.id, payload);
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
        label: 'Borrar', variant: 'danger',
        onClick: ({ close }) => {
          close();
          confirmSheet('Borrar proyecto', 'Las tareas se conservan, pero quedan sin proyecto.', async () => {
            try { await Projects.remove(p.id); await reload(); toast('Proyecto borrado'); }
            catch { toast('No se pudo borrar', 'err'); }
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
            if (isNew) await Projects.create({ ...payload, sort_order: state.projects.length + 1 });
            else await Projects.update(p.id, payload);
            await reload();
            toast(isNew ? 'Proyecto creado' : 'Guardado');
          } catch { toast('No se pudo guardar', 'err'); }
        },
      },
    ],
  });
}

function belSheet() {
  sheet({
    title: 'BEL · nota rápida',
    body: html`
      <p class="sheetText">Escribe lo que sea y queda guardado en <b>Recordatorios</b>.</p>
      <div class="field"><textarea class="textarea" id="bel-text" placeholder="¿Qué quieres anotar?"></textarea></div>`,
    actions: [{
      label: 'Guardar nota', variant: 'primary',
      onClick: async ({ close, root: r }) => {
        const body = $('#bel-text', r).value.trim();
        if (!body) return toast('Escribe algo primero', 'err');
        close();
        try {
          await Notes.create({ body, color: NOTE_COLORS[state.notes.length % NOTE_COLORS.length] });
          await reload();
          toast('Anotado en Recordatorios');
        } catch { toast('No se pudo guardar', 'err'); }
      },
    }],
  });
}

export async function render(container) {
  root = container;
  document.body.dataset.skin = 'taskgrid';

  const cache = readCache('tgModule');
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
            <button type="button" data-section="${s.id}" aria-current="${s.id === state.section}">
              <span>${s.icon}</span>${esc(s.label)}
            </button>`).join(''))}
        </nav>
        <div class="tgSync">
          <b>◍ SINCRONIZADO · TODOS TUS DISPOSITIVOS</b>
          <small>PC + MOBILE</small>
        </div>
      </aside>
      <div class="tgMain" id="tgMain"></div>
    </div>
    <button class="bel" id="belBtn" type="button"><i>◕‿◕</i>BEL</button>`;

  paint();
  await reload({ silent: true });

  $('.tgNav', root).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-section]');
    if (!b) return;
    state.section = b.dataset.section;
    state.picked = null;
    paint();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#belBtn', root).addEventListener('click', belSheet);

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
        duration_min: 30,
      });
      state.capture = { urgent: false, important: false };
    }
    if (e.target.id === 'tgNoteNew') {
      e.preventDefault();
      const ta = $('#tgNoteInput', main);
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      Notes.create({ body, color: NOTE_COLORS[state.notes.length % NOTE_COLORS.length] })
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

    const projEl = e.target.closest('[data-proj]');
    if (projEl && (act === 'openproj' || act === 'editproj')) {
      const p = projectOf(projEl.dataset.proj);
      if (act === 'editproj') return projectSheet(p);
      state.projectFilter = p.id;
      state.section = 'tareas';
      return paint();
    }

    const noteEl = e.target.closest('[data-note]');
    if (noteEl) {
      const id = noteEl.dataset.note;
      const note = state.notes.find((n) => n.id === id);
      if (act === 'notedel') {
        return confirmSheet('Borrar nota', '¿Seguro?', async () => {
          state.notes = state.notes.filter((n) => n.id !== id); paint();
          try { await Notes.remove(id); } catch { toast('No se pudo borrar', 'err'); }
        });
      }
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
      if (ev) return eventSheet(ev);
    }

    const slot = e.target.closest('.tgSlot');
    if (slot && state.picked && !e.target.closest('[data-task]')) {
      const id = state.picked;
      state.picked = null;
      return patchTask(id, { scheduled_date: slot.dataset.date, scheduled_time: slot.dataset.time }, 'Agendada ✓');
    }

    const taskEl = e.target.closest('[data-task]');
    if (!taskEl) return;
    const task = state.tasks.find((t) => t.id === taskEl.dataset.task);
    if (!task) return;
    if (act === 'toggle') return toggleTask(task.id);
    if (act === 'del') return removeTask(task.id);
    if (act === 'edit') return taskSheet(task);
    if (act === 'schedule') return scheduleSheet(task);

    if (taskEl.closest('.tgDragBody')) {
      state.picked = state.picked === task.id ? null : task.id;
      paint();
      if (state.picked) toast('Ahora toca una casilla de la agenda');
    }
  });

  let noteTimer;
  main.addEventListener('input', (e) => {
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

  let dragId = null;
  main.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-task][draggable="true"]');
    if (!el) return;
    dragId = el.dataset.task;
    el.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  main.addEventListener('dragend', () => {
    dragId = null;
    $$('.is-dragging', main).forEach((el) => el.classList.remove('is-dragging'));
  });
  main.addEventListener('dragover', (e) => {
    const slot = e.target.closest('.tgSlot');
    if (!slot || !dragId) return;
    e.preventDefault();
    slot.classList.add('is-drop');
  });
  main.addEventListener('dragleave', (e) => {
    e.target.closest('.tgSlot')?.classList.remove('is-drop');
  });
  main.addEventListener('drop', (e) => {
    const slot = e.target.closest('.tgSlot');
    if (!slot || !dragId) return;
    e.preventDefault();
    slot.classList.remove('is-drop');
    const id = dragId;
    dragId = null;
    patchTask(id, { scheduled_date: slot.dataset.date, scheduled_time: slot.dataset.time }, 'Agendada ✓');
  });

  watch('tasks', ['tasks', 'task_projects', 'notes', 'agenda_events'], () => {
    if (document.activeElement?.dataset?.act === 'notebody') return;
    reload({ silent: true });
  });
}

export function destroy() {
  unwatch('tasks');
  delete document.body.dataset.skin;
}
