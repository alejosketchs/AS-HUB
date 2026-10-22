// Mismo criterio que supabase/functions/bancolombia-ingest/parser.js
// (isOwnCardPayment). La app lo usa para no aprobar, como si fueran ingresos,
// los abonos a la tarjeta propia que ya quedaron en la bandeja.

const OWN_CARD_RE = /para abonar a la deuda|abono a (?:tu |la )?tarjeta de cr[eé]dito/i;

export function isOwnCardPayment(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ');
  return OWN_CARD_RE.test(text);
}
