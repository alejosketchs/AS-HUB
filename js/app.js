// AS HUB — arranque, router y estado de sincronización
import { $, $$ } from './ui.js';
import { requireSession, perfilActivo } from './session.js';
import { APP_VERSION } from './config.js';
import { applyTheme, openUserSettings } from './user-settings.js';

/* El módulo de Tareas es el archivo más pesado del proyecto y hoy vive en un
   espejo. Se pide primero la copia local: cuando el repo esté completo en
   GitHub, esa copia existirá y el espejo dejará de usarse sin tocar nada. */
const ESPEJO = 'https://as-hub-mods-as24-b7b9.vercel.app/views/';

async function vista(nombre) {
  try {
    return await import(`./views/${nombre}.js`);
  } catch {
    return import(/* @vite-ignore */ ESPEJO + nombre + '.js');
  }
}

const routes = {
  '/': () => import('./views/hub.js'),
  '/tareas': () => vista('tasks'),
  '/finanzas': () => import('./views/finance.js'),
};

let current = null;

function path() {
  const raw = (location.hash || '#/').slice(1);
  const clean = raw.split('?')[0].replace(/\/$/, '') || '/';
  if (clean.startsWith('/tareas/')) return '/tareas';
  return routes[clean] ? clean : '/';
}

function markNav(route) {
  $$('[data-route]').forEach((a) => {
    a.classList.toggle('is-on', a.dataset.route === route);
  });
}

async function navigate() {
  const route = path();
  markNav(route);

  if (current?.destroy) {
    try { current.destroy(); } catch { /* noop */ }
  }

  const app = $('#app');
  app.setAttribute('aria-busy', 'true');

  try {
    const mod = await routes[route]();
    current = mod;
    await mod.render(app);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<section class="view"><div class="empty"><b>⚠️</b>
      <p>No se pudo cargar esta sección. Revisa tu conexión y vuelve a intentar.</p></div></section>`;
  } finally {
    app.removeAttribute('aria-busy');
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }
}

/* ---------------- estado de conexión ---------------- */
function paintSync() {
  const pill = $('#syncPill');
  const text = $('#syncText');
  if (!pill) return;
  const on = navigator.onLine;
  pill.classList.toggle('pill--off', !on);
  text.textContent = on ? 'EN LÍNEA' : 'SIN CONEXIÓN';
}

/* ---------------- quién está dentro ---------------- */
function paintWho() {
  const p = perfilActivo();
  if (!p) return;
  $('#whoEmoji').textContent = p.emoji || '👤';
  $('#whoName').textContent = p.name || '';
}

/* ---------------- service worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* no bloquea la app */ });
  });
}

/* ---------------- instalación (Android / escritorio) ---------------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = document.createElement('button');
  btn.className = 'btn btn--pink btn--sm';
  btn.textContent = 'INSTALAR';
  btn.addEventListener('click', async () => {
    btn.remove();
    installPrompt.prompt();
    installPrompt = null;
  });
  $('.topbar .row')?.prepend(btn);
});

/* ---------------- inicio ---------------- */
async function boot() {
  registerSW();
  await requireSession();
  applyTheme();

  $('#shell').classList.remove('hide');
  paintSync();
  paintWho();

  window.addEventListener('online', () => { paintSync(); navigate(); });
  window.addEventListener('offline', paintSync);
  window.addEventListener('hashchange', navigate);

  $('#btnWho').addEventListener('click', () => openUserSettings({
    onChange: async () => { paintWho(); await navigate(); },
  }));

  // Al volver a la app tras un rato, refresca la vista.
  let hidAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hidAt = Date.now();
    else if (Date.now() - hidAt > 60000) navigate();
  });

  await navigate();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `
    <section style="min-height:100dvh;display:grid;place-items:center;padding:28px;text-align:center">
      <div style="max-width:360px;display:grid;gap:14px;justify-items:center">
        <div style="font-size:44px">📡</div>
        <h1 style="font:1000 22px 'Geist Mono',monospace">AS HUB no pudo iniciar</h1>
        <p style="font-size:14px;font-weight:650;color:#9aa2b5;line-height:1.6">
          Casi siempre es la conexión. Revisa que tengas internet y vuelve a abrir.
        </p>
        <button onclick="location.reload()"
          style="padding:13px 18px;font:1000 11px 'Geist Mono',monospace;background:#a8ff1e;color:#111;
                 border:3px solid #111;box-shadow:4px 4px 0 #111;cursor:pointer">REINTENTAR</button>
        <small style="font:700 10px 'Geist Mono',monospace;color:#555">v${APP_VERSION}</small>
      </div>
    </section>`;
});
