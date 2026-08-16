// AS SUITE — sesión con PIN, compartida por todo el ecosistema
//
// Cómo funciona:
//  1. Eliges perfil (Chori o Toli) y escribes tu PIN de 4 dígitos.
//  2. El PIN se convierte en hash (SHA-256 con sal por perfil) y se compara
//     contra el hash guardado en Supabase. El PIN nunca viaja ni se guarda en claro.
//  3. Si coincide, se crea una fila en `sessions` con un token y su vencimiento.
//     El navegador solo guarda ese token; la vigencia la manda la base.
//  4. Cualquier app del Suite que tenga el token puede validarlo contra la misma
//     base, así que la sesión funciona aunque las apps vivan en dominios distintos.
//     Para pasarla a otro sitio se usa el enlace con #as=<token> (ver linkConSesion).

import { Session, Finance } from './db.js';
import { SESSION_KEY, SESSION_DAYS, PIN_SALT } from './config.js';
import { $, $$, html, raw, esc, toast } from './ui.js';

let actual = null; // { token, profile }

/* ---------------- utilidades ---------------- */
export async function hashPin(profileId, pin) {
  const texto = `${PIN_SALT}:${profileId}:${pin}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const leerToken = () => {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
};
const guardarToken = (t) => {
  try { localStorage.setItem(SESSION_KEY, t); } catch { /* modo privado */ }
};
const borrarToken = () => {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
};

/** Si llegamos desde otra app del Suite con #as=<token>, lo adoptamos. */
function adoptarTokenDeLaUrl() {
  const m = (location.hash || '').match(/[#&]as=([A-Za-z0-9-]{8,})/);
  if (!m) return;
  guardarToken(m[1]);
  const limpio = location.hash.replace(/[#&]as=[A-Za-z0-9-]+/, '');
  history.replaceState(null, '', location.pathname + location.search + (limpio || '#/'));
}

/** Enlace a otro sitio del Suite llevando la sesión puesta. */
export function linkConSesion(url) {
  const t = leerToken();
  if (!url || !t) return url;
  return url + (url.includes('#') ? '&' : '#') + 'as=' + encodeURIComponent(t);
}

export const sesion = () => actual;
export const perfilActivo = () => actual?.profile || null;

/** Mantiene el perfil de la sesión y su copia offline alineados tras editar Settings. */
export function actualizarPerfilActivo(patch) {
  if (!actual?.profile) return null;
  actual.profile = { ...actual.profile, ...patch };
  try { localStorage.setItem('assuite:perfil', JSON.stringify(actual.profile)); } catch { /* noop */ }
  return actual.profile;
}

export async function cerrarSesion({ todos = false } = {}) {
  const t = leerToken();
  if (todos && actual?.profile) await Session.closeAll(actual.profile.id);
  else await Session.close(t);
  borrarToken();
  actual = null;
}

/** Cambia el PIN del perfil activo y cierra las demás sesiones. */
export async function cambiarPin(profileId, pinNuevo) {
  const pin_hash = await hashPin(profileId, pinNuevo);
  await Finance.updateProfile(profileId, { pin_hash });
  actualizarPerfilActivo({ pin_hash });
  return pin_hash;
}

/* ---------------- pantalla de entrada ---------------- */
const DIAS_TXT = `${SESSION_DAYS} días`;

function pintarPerfiles(box, perfiles) {
  box.innerHTML = html`
    <p class="gateStep">Paso 1 de 2</p>
    <h2 class="gateTitle">¿Quién eres?</h2>
    <p class="gateHint">Tu sesión queda recordada ${DIAS_TXT} en este dispositivo.</p>
    <div class="gateProfiles">
      ${raw(perfiles.map((p) => `
        <button class="gateProfile" type="button" data-pid="${esc(p.id)}">
          <i>${esc(p.emoji || '👤')}</i>
          <b>${esc(p.name)}</b>
          <small>${esc(p.account_label || 'Perfil del Suite')}</small>
        </button>`).join(''))}
    </div>`;
}

function pintarPin(box, perfil) {
  box.innerHTML = html`
    <p class="gateStep">Paso 2 de 2</p>
    <h2 class="gateTitle">Hola, ${perfil.name}</h2>
    <p class="gateHint" id="gateMsg">Escribe tu PIN de 4 dígitos</p>
    <div class="gateDots" id="gateDots"><i></i><i></i><i></i><i></i></div>
    <div class="gateKeys" id="gateKeys">
      ${raw([1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" data-k="${d}">${d}</button>`).join(''))}
      <button type="button" data-k="back" class="gateKeySoft">Volver</button>
      <button type="button" data-k="0">0</button>
      <button type="button" data-k="del" class="gateKeySoft">⌫</button>
    </div>`;
}

/**
 * Muestra la pantalla de entrada y resuelve cuando hay sesión válida.
 * Devuelve { token, profile }.
 */
export function requireSession() {
  adoptarTokenDeLaUrl();

  return new Promise((resolve) => {
    const gate = $('#gate');
    const box = $('#gateBox');
    let perfiles = [];
    let elegido = null;
    let buffer = '';

    const terminar = (token, profile) => {
      actual = { token, profile };
      gate.classList.add('hide');
      resolve(actual);
    };

    const pintarPuntos = () => {
      $$('#gateDots i').forEach((d, i) => d.classList.toggle('on', i < buffer.length));
    };

    const fallar = (msg) => {
      buffer = ''; pintarPuntos();
      gate.classList.add('is-wrong');
      setTimeout(() => gate.classList.remove('is-wrong'), 420);
      const m = $('#gateMsg');
      if (m) m.textContent = msg;
    };

    const validar = async () => {
      const pin = buffer;
      buffer = ''; pintarPuntos();
      const hash = await hashPin(elegido.id, pin);
      if (hash !== elegido.pin_hash) return fallar('PIN incorrecto, intenta otra vez');
      try {
        const s = await Session.open(elegido.id, SESSION_DAYS, navigator.userAgent.slice(0, 120));
        guardarToken(s.token);
        terminar(s.token, elegido);
      } catch {
        fallar('No se pudo abrir la sesión. Revisa tu conexión.');
      }
    };

    const teclear = (k) => {
      if (k === 'back') { elegido = null; buffer = ''; return pintarPerfiles(box, perfiles); }
      if (k === 'del') { buffer = buffer.slice(0, -1); return pintarPuntos(); }
      if (!/^\d$/.test(k) || buffer.length >= 4) return;
      buffer += k;
      pintarPuntos();
      if (buffer.length === 4) setTimeout(validar, 110);
    };

    box.addEventListener('click', (e) => {
      const perfil = e.target.closest('[data-pid]');
      if (perfil) {
        elegido = perfiles.find((p) => p.id === perfil.dataset.pid);
        buffer = '';
        return pintarPin(box, elegido);
      }
      const tecla = e.target.closest('[data-k]');
      if (tecla) teclear(tecla.dataset.k);
    });

    document.addEventListener('keydown', (e) => {
      if (gate.classList.contains('hide') || !elegido) return;
      if (/^\d$/.test(e.key)) teclear(e.key);
      else if (e.key === 'Backspace') teclear('del');
    });

    (async () => {
      gate.classList.remove('hide');
      box.innerHTML = '<p class="gateHint">Conectando…</p>';

      // 1) ¿Ya hay sesión vigente en este dispositivo?
      const token = leerToken();
      let sesionValida = null;
      try { sesionValida = await Session.check(token); }
      catch {
        // Sin conexión: si el navegador recuerda el perfil, se deja pasar.
        const cache = (() => { try { return JSON.parse(localStorage.getItem('assuite:perfil') || 'null'); } catch { return null; } })();
        if (token && cache) return terminar(token, cache);
        box.innerHTML = html`<p class="gateHint">Sin conexión. Conéctate una vez para entrar.</p>`;
        return;
      }

      try { perfiles = await Finance.profiles(); }
      catch { perfiles = []; }

      if (sesionValida) {
        const p = perfiles.find((x) => x.id === sesionValida.profile_id);
        if (p) {
          try { localStorage.setItem('assuite:perfil', JSON.stringify(p)); } catch { /* noop */ }
          Session.touch(token);
          return terminar(token, p);
        }
      }

      if (!perfiles.length) {
        box.innerHTML = html`<p class="gateHint">No se pudieron cargar los perfiles. Recarga la página.</p>`;
        return;
      }
      if (perfiles.some((p) => !p.pin_hash)) {
        toast('Hay perfiles sin PIN configurado', 'info');
      }
      pintarPerfiles(box, perfiles);
    })();
  });
}
