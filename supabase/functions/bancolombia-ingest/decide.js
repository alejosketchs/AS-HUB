// Decide si un correo de Bancolombia crea un movimiento.
// La bandeja y el automático son excluyentes: un gmail_message_id entra por
// una sola vía. Si la fila ya existe (aunque siga en pending_review), no se
// crea el movimiento aquí; lo crea quien apruebe esa fila, o ya existe.

import { cardBlockReason, looksLikeTransaction, parseBancolombiaAlert } from './parser.js';

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
 * Entre los manuales del mismo perfil, monto, día y tipo, el que todavía
 * no está enlazado a otro correo. Si queda exactamente uno, es el gemelo.
 * Cero, o dos o más libres: no se adivina. Dos compras iguales el mismo día
 * no se funden en un solo movimiento.
 */
export function pickManualTwin(manuals, linkedIds) {
  const linked = new Set((linkedIds || []).filter(Boolean));
  const free = (manuals || []).filter((m) => m?.id && !linked.has(m.id));
  return free.length === 1 ? free[0] : null;
}

/**
 * Correo nuevo (aún no está en la bandeja).
 * createTransaction solo significa "puede crearse si la tarjeta tiene un
 * único perfil". Un ingreso de la 1887, o un pago desde la 8213 hacia esa
 * tarjeta, no se crea solo: queda en pending_review. Ante duda, también.
 * Solo se ignora un correo que ni siquiera trae monto.
 */
export function planNewAlert(rawText) {
  const parsed = parseBancolombiaAlert(rawText);
  const block = cardBlockReason(rawText, parsed);
  if (!parsed) {
    if (!looksLikeTransaction(rawText)) {
      return { createTransaction: false, status: 'ignored', reason: 'sin_monto', parsed: null };
    }
    return {
      createTransaction: false,
      status: 'pending_review',
      reason: block || 'formato_no_reconocido',
      parsed: null,
    };
  }
  if (block) {
    return { createTransaction: false, status: 'pending_review', reason: block, parsed };
  }
  return { createTransaction: true, status: 'pending_review', reason: 'listo_si_hay_perfil', parsed };
}
