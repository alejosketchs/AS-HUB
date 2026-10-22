// Empareja un movimiento anotado a mano con uno que entró del banco.
// No borra nada: solo dice si parecen el mismo.

export function sameAmount(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.005;
}

/** Días de calendario entre dos fechas YYYY-MM-DD (b - a). Null si falta alguna. */
export function daysBetween(isoA, isoB) {
  const a = String(isoA || '').slice(0, 10);
  const b = String(isoB || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const ms = Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`);
  return Math.round(ms / 864e5);
}

function withinOneDay(dateA, dateB) {
  const days = daysBetween(dateA, dateB);
  return days != null && Math.abs(days) <= 1;
}

/** Automáticos del mismo perfil, monto y tipo, con fecha a ±1 día. */
export function findAutomaticTwins(transactions, candidate) {
  if (!candidate) return [];
  return (transactions || []).filter((t) => {
    if (!t || t.source !== 'automatico') return false;
    if (candidate.id && t.id === candidate.id) return false;
    if (String(t.profile_id || '') !== String(candidate.profile_id || '')) return false;
    if (t.type !== candidate.type) return false;
    if (!sameAmount(t.amount, candidate.amount)) return false;
    return withinOneDay(t.transaction_date, candidate.transaction_date);
  });
}

/**
 * Pares manual + automático que parecen el mismo gasto.
 * Un manual puede salir con más de un automático (y al revés): la persona elige.
 */
export function findDuplicatePairs(transactions) {
  const list = transactions || [];
  const autos = list.filter((t) => t && t.source === 'automatico');
  const manuals = list.filter((t) => t && t.source !== 'automatico');
  const pairs = [];
  for (const automatic of autos) {
    for (const manual of manuals) {
      if (String(manual.profile_id || '') !== String(automatic.profile_id || '')) continue;
      if (manual.type !== automatic.type) continue;
      if (!sameAmount(manual.amount, automatic.amount)) continue;
      const days = daysBetween(manual.transaction_date, automatic.transaction_date);
      if (days == null || Math.abs(days) > 1) continue;
      pairs.push({ manual, automatic, days: Math.abs(days) });
    }
  }
  pairs.sort((a, b) => String(b.automatic.transaction_date || '').localeCompare(String(a.automatic.transaction_date || '')));
  return pairs;
}
