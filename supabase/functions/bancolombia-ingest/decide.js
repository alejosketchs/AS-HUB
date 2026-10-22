// Decide si un correo de Bancolombia crea un movimiento.
// La bandeja y el automático son excluyentes: un gmail_message_id entra por
// una sola vía. Si la fila ya existe (aunque siga en pending_review), no se
// crea el movimiento aquí; lo crea quien apruebe esa fila, o ya existe.

import { isCardSettlement, looksLikeTransaction, parseBancolombiaAlert } from './parser.js';

/**
 * Reentrega de un correo que ya está en finance_email_inbox.
 * Nunca crea otro movimiento.
 */
export function planReplay(existingInbox) {
  if (!existingInbox) return null;
  const status = existingInbox.status || 'pending_review';
  return {
    createTransaction: false,
    status,
    reason: status === 'pending_review' ? 'ya_en_bandeja' : 'duplicado',
  };
}

/**
 * Correo nuevo (aún no está en la bandeja).
 * createTransaction solo significa "puede crearse si la tarjeta tiene un
 * único perfil". Un abono o pago de la tarjeta de crédito nunca puede.
 */
export function planNewAlert(rawText) {
  if (isCardSettlement(rawText)) {
    return { createTransaction: false, status: 'ignored', reason: 'pago_tarjeta_propia', parsed: null };
  }
  const parsed = parseBancolombiaAlert(rawText);
  if (!parsed) {
    if (!looksLikeTransaction(rawText)) {
      return { createTransaction: false, status: 'ignored', reason: 'sin_monto', parsed: null };
    }
    return { createTransaction: false, status: 'pending_review', reason: 'formato_no_reconocido', parsed: null };
  }
  return { createTransaction: true, status: 'pending_review', reason: 'listo_si_hay_perfil', parsed };
}
