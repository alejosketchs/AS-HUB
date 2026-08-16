// AS SUITE — panel de usuario y preferencias compartido por todas las secciones
import { Finance } from './db.js';
import { $, $$, sheet, toast, html, raw, esc } from './ui.js';
import { ACCENTS } from './config.js';
import {
  perfilActivo, actualizarPerfilActivo, cambiarPin, hashPin, cerrarSesion,
} from './session.js';

const THEME_KEY = 'assuite:theme';
const safeTheme = (value) => (value === 'dark' ? 'dark' : 'light');

export function applyTheme(profile = perfilActivo()) {
  let saved = '';
  try { saved = localStorage.getItem(THEME_KEY) || ''; } catch { /* noop */ }
  const theme = safeTheme(profile?.theme || saved);
  document.documentElement.dataset.theme = theme;
  const accent = ACCENTS[profile?.accent] || ACCENTS.lima;
  document.documentElement.style.setProperty('--profile-accent', accent.base);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
  return theme;
}

async function saveProfile(patch, onChange) {
  const profile = perfilActivo();
  if (!profile) throw new Error('No active profile');
  const updated = await Finance.updateProfile(profile.id, patch);
  actualizarPerfilActivo(updated);
  applyTheme(updated);
  window.dispatchEvent(new CustomEvent('assuite:profile-updated', { detail: updated }));
  await onChange?.(updated);
  return updated;
}

function profileEditor(onChange) {
  const p = perfilActivo();
  sheet({
    title: 'Editar perfil',
    body: html`
      <div class="userForm">
        <label>Nombre<input class="input" data-user="name" value="${p?.name || ''}" maxlength="40"></label>
        <label>Emoji<input class="input" data-user="emoji" value="${p?.emoji || '👤'}" maxlength="4"></label>
        <label>Cuenta asociada<input class="input" data-user="account" value="${p?.account_label || ''}" maxlength="80" placeholder="Opcional"></label>
      </div>`,
    onOpen: ({ root }) => { root.querySelector('[data-user="name"]')?.focus(); },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      {
        label: 'Guardar', variant: 'primary',
        onClick: async ({ close, root }) => {
          const name = $('[data-user="name"]', root).value.trim();
          if (!name) return toast('Escribe un nombre', 'err');
          const patch = {
            name,
            emoji: $('[data-user="emoji"]', root).value.trim() || '👤',
            account_label: $('[data-user="account"]', root).value.trim(),
          };
          try { await saveProfile(patch, onChange); close(); toast('Perfil actualizado ✓'); }
          catch { toast('No se pudo guardar el perfil', 'err'); }
        },
      },
    ],
  });
}

function pinEditor(onChange) {
  sheet({
    title: 'Cambiar PIN',
    body: html`
      <div class="userForm">
        <label>PIN actual<input class="input" type="password" inputmode="numeric" maxlength="4" data-pin="old" placeholder="••••"></label>
        <label>PIN nuevo<input class="input" type="password" inputmode="numeric" maxlength="4" data-pin="new" placeholder="••••"></label>
        <label>Repite el PIN<input class="input" type="password" inputmode="numeric" maxlength="4" data-pin="repeat" placeholder="••••"></label>
        <p class="sheetText">El PIN se transforma en un hash antes de guardarse; nunca se envía en texto plano.</p>
      </div>`,
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => close() },
      {
        label: 'Guardar', variant: 'primary',
        onClick: async ({ close, root }) => {
          const oldPin = $('[data-pin="old"]', root).value.trim();
          const nextPin = $('[data-pin="new"]', root).value.trim();
          const repeat = $('[data-pin="repeat"]', root).value.trim();
          const p = perfilActivo();
          if (!/^\d{4}$/.test(nextPin)) return toast('El PIN nuevo debe tener 4 dígitos', 'err');
          if (nextPin !== repeat) return toast('Los PIN nuevos no coinciden', 'err');
          if (p?.pin_hash && await hashPin(p.id, oldPin) !== p.pin_hash) return toast('El PIN actual no es correcto', 'err');
          try {
            await cambiarPin(p.id, nextPin);
            await onChange?.(perfilActivo());
            close();
            toast('PIN actualizado ✓');
          } catch { toast('No se pudo guardar el PIN', 'err'); }
        },
      },
    ],
  });
}

function appearanceEditor(onChange) {
  const p = perfilActivo();
  const previousTheme = applyTheme(p);
  let theme = previousTheme;
  let accent = p?.accent || 'lima';
  sheet({
    title: 'Apariencia',
    body: html`
      <div class="userForm">
        <label>Tema
          <select class="select" data-user-theme>
            <option value="light" ${theme === 'light' ? 'selected' : ''}>Claro</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Oscuro</option>
          </select>
        </label>
        <div><span class="userLabel">Color de interfaz</span>
          <div class="userAccents">
            ${raw(Object.entries(ACCENTS).map(([key, item]) => `
              <button type="button" data-user-accent="${esc(key)}" aria-current="${key === accent}">
                <i style="background:${item.base}"></i><b>${esc(item.label)}</b>
              </button>`).join(''))}
          </div>
        </div>
        <p class="sheetText">El Hub conserva su fondo oscuro de identidad. El tema se aplica a Tareas, Finanzas y ventanas de trabajo.</p>
      </div>`,
    onOpen: ({ root }) => {
      $('[data-user-theme]', root).addEventListener('change', (event) => {
        theme = safeTheme(event.target.value);
        applyTheme({ theme });
      });
      $$('[data-user-accent]', root).forEach((button) => button.addEventListener('click', () => {
        accent = button.dataset.userAccent;
        document.documentElement.style.setProperty('--profile-accent', ACCENTS[accent]?.base || ACCENTS.lima.base);
        $$('[data-user-accent]', root).forEach((item) => item.setAttribute('aria-current', String(item === button)));
      }));
    },
    actions: [
      { label: 'Cancelar', onClick: ({ close }) => { applyTheme(p); close(); } },
      {
        label: 'Aplicar', variant: 'primary',
        onClick: async ({ close }) => {
          try { await saveProfile({ theme, accent }, onChange); close(); toast('Apariencia guardada ✓'); }
          catch { applyTheme({ theme: previousTheme }); toast('No se pudo guardar la apariencia', 'err'); }
        },
      },
    ],
  });
}

export function openUserSettings({ onChange } = {}) {
  const p = perfilActivo();
  sheet({
    title: 'Usuario y ajustes',
    body: html`
      <div class="userSummary"><i>${p?.emoji || '👤'}</i><div><b>${p?.name || 'Perfil'}</b><small>${p?.account_label || 'AS Suite'}</small></div></div>
      <div class="userMenu">
        <button type="button" data-setting="profile"><i>✍️</i><span><b>Perfil</b><small>Nombre, emoji y cuenta</small></span></button>
        <button type="button" data-setting="pin"><i>🔑</i><span><b>Cambiar PIN</b><small>Seguridad del perfil</small></span></button>
        <button type="button" data-setting="appearance"><i>🎨</i><span><b>Apariencia</b><small>Tema y color de interfaz</small></span></button>
        <button type="button" data-setting="switch"><i>⇄</i><span><b>Cambiar perfil</b><small>Vuelve al selector seguro</small></span></button>
        <button class="is-soft" type="button" data-setting="logout"><i>🚪</i><span><b>Cerrar sesión</b><small>Solo en este dispositivo</small></span></button>
      </div>`,
    onOpen: ({ root, close }) => {
      $$('[data-setting]', root).forEach((button) => button.addEventListener('click', () => {
        const action = button.dataset.setting;
        close();
        setTimeout(async () => {
          if (action === 'profile') profileEditor(onChange);
          if (action === 'pin') pinEditor(onChange);
          if (action === 'appearance') appearanceEditor(onChange);
          if (action === 'switch' || action === 'logout') {
            await cerrarSesion();
            location.reload();
          }
        }, 180);
      }));
    },
    actions: [{ label: 'Cerrar', onClick: ({ close }) => close() }],
  });
}
