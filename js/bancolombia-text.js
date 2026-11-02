// La regla vive en el parser de la función (una sola copia).
// La bandeja la usa para no meter en "Aprobar todas" un abono de la 1887
// ni un pago desde la 8213 hacia esa tarjeta.
export {
  alertWindow,
  batchSkipReasons,
  CARD_BLOCK_PATTERNS,
  cardBlockReason,
  CREDIT_CARD_LAST4,
  isCardSettlement,
  isOwnCardPayment,
  SAVINGS_LAST4,
  WINDOW_AFTER,
  WINDOW_BEFORE,
} from '../supabase/functions/bancolombia-ingest/parser.js';
