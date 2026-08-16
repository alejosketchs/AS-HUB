// AS HUB — utilidades de interfaz
import { TZ, CURRENCY } from './config.js';

/* ---------- DOM ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Tag template que escapa todo lo interpolado salvo lo envuelto en raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    let piece;
    if (v == null || v === false) piece = '';
    else if (v && v.__raw) piece = v.value;
    else if (Array.isArray(v)) piece = v.map((x) => (x && x.__raw ? x.value : esc(x))).join('');
    else piece = esc(v);
    return out + piece + s;
  }, '');
}
export const raw = (value) => ({ __raw: true, value: value ?? '' });

/* ---------- Formatos ---------- */
const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: CURRENCY, maximumFractionDigits: 0,
});
const compactFmt = new Intl.NumberFormat('es-CO', {
  notation: 'compact', maximumFractionDigits: 1,
});

export const money = (n) => moneyFmt.format(Number(n) || 0);
export const moneyShort = (n) => '$' + compactFmt.format(Number(n) || 0);
export const num = (n) => new Intl.NumberFormat('es-CO').format(Number(n) || 0);

/* ---------- Fechas (siempre en horario de Bogotá) ---------- */
export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Fecha (en Bogotá) de una marca de tiempo ISO. Evita que algo hecho
 *  a las 8 p.m. cuente como "mañana" por el desfase con UTC. */
export function dayOf(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: TZ });
}

export function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

export function monthRange(year, month /* 1-12 */) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export const monthName = (m) => MESES[m - 1];

export function fmtDate(iso, { weekday = false } = {}) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  const base = `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}`;
  return weekday ? `${DIAS[d.getDay()]} ${base}` : base;
}

export function relativeDay(iso) {
  if (!iso) return '';
  const today = todayISO();
  if (iso === today) return 'Hoy';
  if (iso === addDays(today, 1)) return 'Mañana';
  if (iso === addDays(today, -1)) return 'Ayer';
  return fmtDate(iso, { weekday: true });
}

export const isOverdue = (iso) => !!iso && iso < todayISO();

/** Fecha de la última publicación, leída del propio servidor.
 *  Así el pie del Hub se actualiza solo en cada despliegue, sin tocar código. */
export async function buildDate(fallback) {
  try {
    const res = await fetch('/js/config.js', { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('last-modified');
    if (lm) {
      const d = new Date(lm);
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-CA', { timeZone: TZ });
    }
  } catch { /* sin conexión: se usa el respaldo */ }
  return fallback;
}

/* ---------- Toast ---------- */
let toastTimer;
export function toast(message, kind = 'ok') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.className = 'toast toast--' + kind;
  box.textContent = message;
  box.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-on'), 2600);
}

/* ---------- Hoja modal ---------- */
export function sheet({ title, body, actions = [], onOpen }) {
  const back = document.createElement('div');
  back.className = 'sheetBack';
  back.innerHTML = html`
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="sheetHead">
        <h3>${title}</h3>
        <button class="sheetClose" type="button" aria-label="Cerrar">✕</button>
      </div>
      <div class="sheetBody">${raw(body)}</div>
      <div class="sheetFoot"></div>
    </div>`;

  const close = () => {
    back.classList.remove('is-on');
    setTimeout(() => back.remove(), 180);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const foot = $('.sheetFoot', back);
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (a.variant ? 'btn--' + a.variant : '');
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick?.({ close, root: back }));
    foot.appendChild(b);
  });

  $('.sheetClose', back).addEventListener('click', close);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('is-on'));
  onOpen?.({ root: back, close });
  const firstField = back.querySelector('input,textarea,select');
  if (firstField && window.matchMedia('(min-width: 720px)').matches) firstField.focus();
  return { close, root: back };
}

export function confirmSheet(title, message, onYes) {
  sheet({
    title,
    body: html`<p class="sheetText">${message}</p>`,
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      { label: 'Sí, borrar', variant: 'danger', onClick: ({ close }) => { close(); onYes(); } },
    ],
  });
}

/* ---------- Varios ---------- */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function pct(part, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}
