// Mismo criterio que supabase/functions/bancolombia-ingest/parser.js
// (isCardSettlement). La app lo usa para no aprobar, como si fueran gastos
// o ingresos, los abonos y pagos de la tarjeta propia que ya quedaron en la bandeja.

const OWN_CARD_RE = /para abonar a la deuda|abono a (?:tu |la )?tarjeta de cr[eé]dito|(?:pag\w*|pago)\b(?:(?!\ben\b).){0,80}?\b(?:a |de )?(?:tu |la )?tarjeta de cr[eé]dito/i;

function flat(rawText) {
  return String(rawText || '').replace(/\s+/g, ' ');
}

export function isOwnCardPayment(rawText) {
  return OWN_CARD_RE.test(flat(rawText));
}

export function isCardSettlement(rawText) {
  return isOwnCardPayment(rawText);
}
