// AS SUITE — bloqueo rápido por PIN (solo en este dispositivo)
//
// No protege la base (eso lo hace la sesión de Supabase Auth + RLS). Sirve
// para elegir perfil (Shori/Toli) y que nadie con el teléfono en la mano
// entre sin el PIN. Funciones puras para poder probarlas con node --test.

export const LOCK_KEY = 'assuite:pinlock';

/** Estado guardado: { profileId, until } o null. */
export function readLock(storage) {
  try {
    const raw = storage.getItem(LOCK_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && typeof s.profileId === 'string' && typeof s.until === 'number' ? s : null;
  } catch { return null; }
}

export function isUnlocked(state, now = Date.now()) {
  return !!state && state.until > now;
}

export function unlock(storage, profileId, days, now = Date.now()) {
  const state = { profileId, until: now + days * 864e5 };
  try { storage.setItem(LOCK_KEY, JSON.stringify(state)); } catch { /* modo privado */ }
  return state;
}

export function lock(storage) {
  try { storage.removeItem(LOCK_KEY); } catch { /* noop */ }
}
