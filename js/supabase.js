// AS SUITE — cliente único de Supabase + sesión real (Supabase Auth)
//
// Todo lo que hable con Supabase importa `sb` desde aquí. La base solo deja
// leer/escribir con una sesión de Auth de un dueño (ver docs/seguridad.md);
// la llave publicable de config.js es pública y por sí sola no abre nada.
import { SUPABASE_URL, SUPABASE_KEY, AUTH_STORAGE_KEY } from './config.js';

// Se intenta más de un CDN: si uno falla, la app sigue funcionando.
const CDNS = [
  'https://esm.sh/@supabase/supabase-js@2.45.4',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm',
  'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/module/index.js',
];

async function loadCreateClient() {
  let lastError;
  for (const url of CDNS) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      if (mod?.createClient) return mod.createClient;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('No se pudo cargar la librería de datos');
}

// Se lee antes de crear el cliente, porque el cliente limpia el hash al leerlo.
export const cameFromRecovery = /[#&]type=recovery/.test(location.hash || '');

const createClient = await loadCreateClient();

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // enlace de "olvidé mi contraseña"
    storageKey: AUTH_STORAGE_KEY,
  },
  realtime: { params: { eventsPerSecond: 5 } },
});

/* ---------------- Auth ---------------- */

/** Sesión guardada en este dispositivo (no necesita red). null si no hay. */
export async function getAuthSession() {
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data.session;
}

/** scope 'local' = este dispositivo; 'global' = todos los dispositivos. */
export async function signOut(scope = 'local') {
  const { error } = await sb.auth.signOut({ scope });
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  if (error) throw error;
}

export async function setNewPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}

/** Avisa cuando el usuario llega desde el correo de recuperación. */
export function onPasswordRecovery(cb) {
  const { data } = sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') cb();
  });
  return () => data.subscription.unsubscribe();
}
