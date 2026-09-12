// AS HUB — pantalla de inicio
import { Tasks, Finance, Settings, cached } from '../db.js';
import {
  $, $$, html, raw, esc, money, moneyShort, todayISO, dayOf, monthRange, pct,
  buildDate, sheet, toast,
} from '../ui.js';
import { FRASES, SITIOS_EXTRA, APP_VERSION, BUILD_DATE } from '../config.js';
import { linkConSesion, perfilActivo } from '../session.js';

/* Reader Tracker vive en su propio sitio (mismo Supabase, mismo login PIN).
   Aquí solo se enlaza con la sesión puesta para que no pida PIN otra vez. */
const READER_URL = 'https://as-reader-as24-b7b9.vercel.app/';

/* Memo Recall vive en su propio sitio (mismo Supabase, mismo login PIN).
   Aquí solo se enlaza con la sesión puesta para que no pida PIN otra vez. */
const MEMO_URL = 'https://as-memo.vercel.app/';

function fraseDelDia() {
  const iso = todayISO();
  const seed = Number(iso.replaceAll('-', '')) % FRASES.length;
  return FRASES[seed];
}

function saludo() {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }));
  if (h < 6) return 'Trasnochando';
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

const chip = (t) => `<span>${t}</span>`;

/* ---------------- armazón ---------------- */
function shell(nombre) {
  const frase = fraseDelDia();
  return html`
    <section class="view">
      <!-- 1 · frase del día -->
      <aside class="daily daily--top">
        <span>✦ MENSAJE DEL DÍA</span>
        <p>${frase.quote}</p>
        <b>— ${frase.author}</b>
        <small>${frase.source ? `Fuente: ${frase.source}` : 'Fuente no disponible'}</small>
      </aside>

      <div class="viewHead">
        <div>
          <span class="tag">${saludo().toUpperCase()}, ${(nombre || '').toUpperCase()}</span>
          <h1 class="display">ELIGE TU<em>PRÓXIMA MISIÓN.</em></h1>
        </div>
        <p>Tareas y finanzas en un solo lugar, sincronizadas entre tu celular y tu computador.</p>
      </div>

      <!-- 2 · estadísticas -->
      <div class="statGrid" id="hubStats"></div>

      <!-- 3 · apps -->
      <h3 class="secTitle">Tus apps</h3>
      <div class="appGrid">
        <a class="appCard tilt-a" href="#/tareas" style="--accent:var(--yellow)">
          <span class="appNum">#01</span>
          <div class="appIcon">✓</div>
          <p class="appLabel">ORGANIZA EL CAOS</p>
          <h2>Tareas</h2>
          <p>Inbox, agenda del día, proyectos y post-its. Todo lo que tienes pendiente, sin ruido.</p>
          <div class="appStats">${raw(chip('Cargando…'))}</div>
          <div class="appOpen">ABRIR <b>↗</b></div>
        </a>

        <a class="appCard tilt-b" href="#/finanzas" style="--accent:var(--lime)">
          <span class="appNum">#02</span>
          <div class="appIcon">$</div>
          <p class="appLabel">DINERO SIN DRAMA</p>
          <h2>Finanzas</h2>
          <p>Movimientos, presupuesto, check list mensual, metas y deudas. Un perfil para cada uno.</p>
          <div class="appStats">${raw(chip('Cargando…'))}</div>
          <div class="appOpen">ABRIR <b>↗</b></div>
        </a>

        <a class="appCard tilt-a" href="${linkConSesion(READER_URL)}" target="_blank" rel="noopener" style="--accent:var(--wine)">
          <span class="appNum">#03</span>
          <div class="appIcon">R</div>
          <p class="appLabel">LEE · AVANZA · SUBE DE NIVEL</p>
          <h2>Reader Tracker</h2>
          <p>Cada página suma XP, logros y una season mensual entre los dos.</p>
          <div class="appStats">${raw(chip('Libros') + chip('XP') + chip('Logros'))}</div>
          <div class="appOpen">ABRIR <b>↗</b></div>
        </a>

        <a class="appCard tilt-b" href="${linkConSesion(MEMO_URL)}" target="_blank" rel="noopener" style="--accent:var(--purple)">
          <span class="appNum">#04</span>
          <div class="appIcon">M</div>
          <p class="appLabel">ESTUDIA · RECUERDA · DOMINA</p>
          <h2>Memo Recall</h2>
          <p>Flashcards con repetición espaciada, IA y niveles para fijar lo que estudias.</p>
          <div class="appStats">${raw(chip('Decks') + chip('XP') + chip('Racha'))}</div>
          <div class="appOpen">ABRIR <b>↗</b></div>
        </a>
      </div>

      <!-- sitios extra -->
      <h3 class="secTitle">Sitios extra</h3>
      <div class="extraGrid" id="hubExtra"></div>

      <!-- 4 · cierre -->
      <footer class="hubFoot">
        <div>
          <b>AS SUITE</b>
          <small>Hecho para Shori y Toli.</small>
        </div>
        <div class="hubFootMeta">
          <span>versión <b>${APP_VERSION}</b></span>
          <span>actualizado <b id="hubBuild">${BUILD_DATE}</b></span>
        </div>
      </footer>
    </section>`;
}

/* ---------------- sitios extra ---------------- */
function pintarExtra(root, links) {
  const box = $('#hubExtra', root);
  if (!box) return;
  box.innerHTML = SITIOS_EXTRA.map((s) => {
    const url = links[s.key] || '';
    const destino = url ? linkConSesion(url) : '';
    const tag = url ? 'a' : 'button';
    const attrs = url
      ? `href="${esc(destino)}" target="_blank" rel="noopener"`
      : 'type="button"';
    return `<${tag} class="extraCard ${url ? '' : 'is-empty'}" ${attrs}
              data-extra="${esc(s.key)}" style="--accent:${esc(s.accent)}">
        <i>${esc(s.emoji)}</i>
        <div>
          <b>${esc(s.nombre)}</b>
          <small>${url ? esc(s.descripcion) : 'Sin enlace todavía · toca para agregarlo'}</small>
        </div>
        <em>${url ? '↗' : '+'}</em>
      </${tag}>`;
  }).join('');

  $$('.extraCard.is-empty', box).forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.extra;
      const meta = SITIOS_EXTRA.find((s) => s.key === key);
      sheet({
        title: 'Enlace de ' + meta.nombre,
        body: html`
          <div class="field"><label>Dirección del sitio</label>
            <input class="input" id="lnk" type="url" placeholder="https://…" value=""></div>
          <p class="sheetText" style="font-size:12.5px;color:var(--muted)">
          Se guarda en la base, así que queda igual en tu celular y en el computador.</p>`,
        actions: [
          { label: 'Cancelar', onClick: ({ close }) => close() },
          {
            label: 'Guardar',
            variant: 'primary',
            onClick: async ({ close, root: r }) => {
              const url = $('#lnk', r).value.trim();
              if (!/^https?:\/\//i.test(url)) return toast('Pega una dirección que empiece por https://', 'err');
              close();
              try {
                const actual = await Settings.read('links');
                await Settings.write('links', { ...actual, [key]: url });
                toast('Enlace guardado');
                pintarExtra(root, { ...actual, [key]: url });
              } catch { toast('No se pudo guardar', 'err'); }
            },
          },
        ],
      });
    });
  });
}

/* ---------------- montaje ---------------- */
export async function render(root) {
  const perfil = perfilActivo();
  root.innerHTML = shell(perfil?.name || 'Alejo');

  buildDate(BUILD_DATE).then((d) => {
    const el = $('#hubBuild', root);
    if (el) el.textContent = d;
  });

  Settings.read('links').then((l) => pintarExtra(root, l || {})).catch(() => pintarExtra(root, {}));

  const today = todayISO();
  const now = new Date(today + 'T12:00:00');
  const { from, to } = monthRange(now.getFullYear(), now.getMonth() + 1);
  const pid = perfil?.id || 'alejo';

  const paint = ({ tasks, txs, budgets }) => {
    const open = tasks.filter((t) => t.status !== 'done');
    const dueToday = open.filter((t) => t.due_date === today).length;
    const late = open.filter((t) => t.due_date && t.due_date < today).length;
    const doneToday = tasks.filter((t) => t.status === 'done' && dayOf(t.completed_at) === today).length;

    // Gasto real: sin reembolsables (vuelven) ni ahorros (no son gasto).
    const spent = txs.filter((t) => t.type === 'expense' && !t.reimbursable).reduce((s, t) => s + Number(t.amount), 0);
    const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    // Plan del mes: fijos + ahorro planeado + semanales llevados a mes.
    const planned = budgets.filter((b) => b.active !== false && b.kind !== 'saving')
      .reduce((s, b) => s + Number(b.amount) * (b.period === 'week' ? 4.33 : 1), 0);

    const tChips = [chip(`${open.length} abiertas`), chip(`${dueToday} para hoy`)];
    if (late) tChips.push(chip(`⚠ ${late} vencidas`));
    const mChips = [chip(`${moneyShort(spent)} gastado`), chip(`${planned ? pct(spent, planned) : 0}% del plan`)];

    const cards = root.querySelectorAll('.appStats');
    if (cards[0]) cards[0].innerHTML = tChips.join('');
    if (cards[1]) cards[1].innerHTML = mChips.join('');

    const free = Math.max(0, planned - spent);
    $('#hubStats', root).innerHTML = html`
      <article class="stat yellow">
        <span>MISIÓN · TAREAS</span>
        <strong>${String(doneToday)}</strong>
        <div class="bar"><i style="width:${String(pct(doneToday, doneToday + open.length))}%"></i></div>
        <small>completadas hoy · ${String(open.length)} pendientes</small>
      </article>
      <article class="stat lime">
        <span>STATUS · GASTO DEL MES</span>
        <strong>${money(spent)}</strong>
        <div class="bar ${planned && spent > planned ? 'over' : ''}"><i style="width:${String(pct(spent, planned))}%"></i></div>
        <small>${planned ? money(free) + ' libres del presupuesto' : 'sin presupuesto configurado'}</small>
      </article>
      <article class="stat blue">
        <span>INGRESOS DEL MES</span>
        <strong>${money(income)}</strong>
        <div class="bar"><i style="width:${String(pct(income, Math.max(income, spent)))}%"></i></div>
        <small>balance ${money(income - spent)}</small>
      </article>`;
  };

  try {
    await cached('hub:' + pid, async () => {
      const [tasks, txs, budgets] = await Promise.all([
        Tasks.list(),
        Finance.transactions(pid, from, to),
        Finance.budgets(pid),
      ]);
      return { tasks, txs, budgets };
    }, paint);
  } catch {
    const cards = root.querySelectorAll('.appStats');
    if (cards[0]) cards[0].innerHTML = chip('sin conexión');
    if (cards[1]) cards[1].innerHTML = chip('sin conexión');
    $('#hubStats', root).innerHTML = '<div class="empty"><b>📡</b><p>Sin conexión: las estadísticas vuelven cuando haya red.</p></div>';
  }
}
