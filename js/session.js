// AS SUITE — entrada a la app
//
// Cómo funciona:
//  1. Sesión real: correo + contraseña con Supabase Auth (js/supabase.js).
//     Sin esa sesión la base no deja leer ni escribir nada (RLS, ver
//     docs/seguridad.md). Queda recordada en este dispositivo y se renueva sola.
//  2. Bloqueo rápido: eliges perfil (Shori o Toli) y escribes su PIN de 4
//     dígitos. El PIN se compara como hash (SHA-256 con sal por perfil) y solo
//     decide qué perfil ves en este dispositivo; no es la seguridad de la base.

import { Finance } from './db.js';
import {
  getAuthSession, signIn, signOut, sendPasswordReset, setNewPassword, cameFromRecovery,
} from './supabase.js';
import { readLock, isUnlocked, unlock, lock } from './pin-lock.js';
import { PIN_DAYS, PIN_SALT } from './config.js';
import { $, $$, html, raw, esc, toast } from './ui.js';

const PERFIL_CACHE = 'assuite:perfil';

let actual = null; // { user, profile }

/* ---------------- utilidades ---------------- */
export async function hashPin(profileId, pin) {
  const texto = `${PIN_SALT}:${profileId}:${pin}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const leerPerfilCache = () => {
  try { return JSON.parse(localStorage.getItem(PERFIL_CACHE) || 'null'); } catch { return null; }
};
const guardarPerfilCache = (p) => {
  try { localStorage.setItem(PERFIL_CACHE, JSON.stringify(p)); } catch { /* noop */ }
};

export const sesion = () => actual;
export const perfilActivo = () => actual?.profile || null;

/** Mantiene el perfil de la sesión y su copia offline alineados tras editar Settings. */
export function actualizarPerfilActivo(patch) {
  if (!actual?.profile) return null;
  actual.profile = { ...actual.profile, ...patch };
  guardarPerfilCache(actual.profile);
  return actual.profile;
}

/** Vuelve al selector de perfil + PIN sin cerrar la sesión de la cuenta. */
export function cambiarPerfil() {
  lock(localStorage);
}

/** Cierra la sesión de la cuenta (todos = en todos los dispositivos). */
export async function cerrarSesion({ todos = false } = {}) {
  lock(localStorage);
  try { localStorage.removeItem(PERFIL_CACHE); } catch { /* noop */ }
  try { await signOut(todos ? 'global' : 'local'); } catch { /* sin red: se borra igual en local */ }
  actual = null;
}

/** Cambia el PIN del perfil activo. */
export async function cambiarPin(profileId, pinNuevo) {
  const pin_hash = await hashPin(profileId, pinNuevo);
  await Finance.updateProfile(profileId, { pin_hash });
  actualizarPerfilActivo({ pin_hash });
  return pin_hash;
}

/* ---------------- pantallas de entrada ---------------- */
const DIAS_TXT = `${PIN_DAYS} días`;

function pintarLogin(box, msg = '') {
  box.innerHTML = html`
    <p class="gateStep">Entrar</p>
    <h2 class="gateTitle">Inicia sesión</h2>
    <p class="gateHint" id="gateMsg">${msg || 'Con tu correo y contraseña. Queda recordado en este dispositivo.'}</p>
    <form id="gateLogin" class="gateForm" novalidate>
      <div class="field"><label for="gateEmail">CORREO</label>
        <input class="input" id="gateEmail" type="email" autocomplete="username" required></div>
      <div class="field"><label for="gatePass">CONTRASEÑA</label>
        <input class="input" id="gatePass" type="password" autocomplete="current-password" required></div>
      <button class="btn btn--primary btn--block" type="submit">ENTRAR</button>
      <button class="btn btn--sm gateKeySoft" type="button" data-act="reset">Olvidé mi contraseña</button>
    </form>`;
}

function pintarNuevaClave(box) {
  box.innerHTML = html`
    <p class="gateStep">Recuperar acceso</p>
    <h2 class="gateTitle">Nueva contraseña</h2>
    <p class="gateHint" id="gateMsg">Mínimo 10 caracteres. Que no la uses en otro sitio.</p>
    <form id="gateNewPass" class="gateForm" novalidate>
      <div class="field"><label for="gateNew">CONTRASEÑA NUEVA</label>
        <input class="input" id="gateNew" type="password" autocomplete="new-password" minlength="10" required></div>
      <button class="btn btn--primary btn--block" type="submit">GUARDAR</button>
    </form>`;
}

function pintarPerfiles(box, perfiles) {
  box.innerHTML = html`
    <p class="gateStep">Paso 1 de 2</p>
    <h2 class="gateTitle">¿Qué perfil?</h2>
    <p class="gateHint">El PIN queda recordado ${DIAS_TXT} en este dispositivo.</p>
    <div class="gateProfiles">
      ${raw(perfiles.map((p) => `
        <button class="gateProfile" type="button" data-pid="${esc(p.id)}">
          <i>${esc(p.emoji || '👤')}</i>
          <b>${esc(p.name)}</b>
          <small>${esc(p.account_label || 'Perfil del Suite')}</small>
        </button>`).join(''))}
    </div>
    <button class="btn btn--sm gateKeySoft" type="button" data-act="logout">Cerrar sesión de la cuenta</button>`;
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

const mensaje = (texto) => { const m = $('#gateMsg'); if (m) m.textContent = texto; };

/**
 * Muestra la pantalla de entrada y resuelve cuando hay sesión de cuenta
 * y perfil desbloqueado. Devuelve { user, profile }.
 */
export function requireSession() {
  return new Promise((resolve) => {
    const gate = $('#gate');
    const box = $('#gateBox');
    let user = null;
    let perfiles = [];
    let elegido = null;
    let buffer = '';

    const terminar = (profile) => {
      actual = { user, profile };
      guardarPerfilCache(profile);
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
      mensaje(msg);
    };

    const validarPin = async () => {
      const pin = buffer;
      buffer = ''; pintarPuntos();
      if (await hashPin(elegido.id, pin) !== elegido.pin_hash) return fallar('PIN incorrecto, intenta otra vez');
      unlock(localStorage, elegido.id, PIN_DAYS);
      terminar(elegido);
    };

    const elegirPerfil = (p) => {
      elegido = p;
      buffer = '';
      if (!p.pin_hash) { // perfil sin PIN: no hay bloqueo que pedir
        unlock(localStorage, p.id, PIN_DAYS);
        return terminar(p);
      }
      pintarPin(box, p);
    };

    const teclear = (k) => {
      if (k === 'back') { elegido = null; buffer = ''; return pintarPerfiles(box, perfiles); }
      if (k === 'del') { buffer = buffer.slice(0, -1); return pintarPuntos(); }
      if (!/^\d$/.test(k) || buffer.length >= 4) return;
      buffer += k;
      pintarPuntos();
      if (buffer.length === 4) setTimeout(validarPin, 110);
    };

    /* Ya con cuenta: cargar perfiles y pedir PIN si hace falta. */
    const trasCuenta = async () => {
      const candado = readLock(localStorage);
      try { perfiles = await Finance.profiles(); }
      catch {
        // Sin conexión: se deja pasar con el perfil que este dispositivo ya desbloqueó.
        const cache = leerPerfilCache();
        if (cache && isUnlocked(candado) && candado.profileId === cache.id) return terminar(cache);
        box.innerHTML = html`<p class="gateHint">No se pudieron cargar los perfiles. Revisa tu conexión y recarga.</p>`;
        return;
      }
      if (!perfiles.length) {
        box.innerHTML = html`<p class="gateHint">Esta cuenta no tiene acceso a los datos del Suite.</p>`;
        return;
      }
      if (isUnlocked(candado)) {
        const p = perfiles.find((x) => x.id === candado.profileId);
        if (p) return terminar(p);
      }
      if (perfiles.some((p) => !p.pin_hash)) toast('Hay perfiles sin PIN configurado', 'info');
      pintarPerfiles(box, perfiles);
    };

    box.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'logout') { await cerrarSesion(); return pintarLogin(box); }
      if (act === 'reset') {
        const email = $('#gateEmail')?.value || '';
        if (!email.includes('@')) return mensaje('Escribe tu correo arriba y vuelve a tocar "Olvidé mi contraseña".');
        try { await sendPasswordReset(email); mensaje('Si el correo es correcto, te llegó un enlace para crear una contraseña nueva.'); }
        catch { mensaje('No se pudo enviar el correo. Intenta en unos minutos.'); }
        return;
      }
      const perfil = e.target.closest('[data-pid]');
      if (perfil) return elegirPerfil(perfiles.find((p) => p.id === perfil.dataset.pid));
      const tecla = e.target.closest('[data-k]');
      if (tecla) teclear(tecla.dataset.k);
    });

    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        if (e.target.id === 'gateLogin') {
          const s = await signIn($('#gateEmail').value, $('#gatePass').value);
          user = s.user;
          box.innerHTML = '<p class="gateHint">Entrando…</p>';
          await trasCuenta();
        } else if (e.target.id === 'gateNewPass') {
          const nueva = $('#gateNew').value;
          if (nueva.length < 10) { mensaje('Usa al menos 10 caracteres.'); return; }
          await setNewPassword(nueva);
          toast('Contraseña actualizada');
          await trasCuenta();
        }
      } catch (err) {
        mensaje(/invalid login/i.test(err?.message || '')
          ? 'Correo o contraseña incorrectos.'
          : /pwned|leaked|weak/i.test(err?.message || '')
            ? 'Esa contraseña aparece en filtraciones públicas. Usa otra.'
            : 'No se pudo completar. Revisa tu conexión e intenta otra vez.');
      } finally {
        btn.disabled = false;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (gate.classList.contains('hide') || !elegido || !$('#gateKeys')) return;
      if (/^\d$/.test(e.key)) teclear(e.key);
      else if (e.key === 'Backspace') teclear('del');
    });

    (async () => {
      gate.classList.remove('hide');
      box.innerHTML = '<p class="gateHint">Conectando…</p>';

      const cuenta = await getAuthSession();
      if (!cuenta) {
        if (!navigator.onLine) {
          box.innerHTML = html`<p class="gateHint">Sin conexión. Conéctate una vez para entrar.</p>`;
          return;
        }
        return pintarLogin(box);
      }
      user = cuenta.user;
      if (cameFromRecovery) return pintarNuevaClave(box);
      await trasCuenta();
    })();
  });
}
