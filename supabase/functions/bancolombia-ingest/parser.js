// Parser de alertas de Bancolombia (correo -> movimiento).
// Nunca inventa datos: si no reconoce el formato devuelve null y el correo
// queda en finance_email_inbox para completar a mano.
//
// Deliberadamente NO usa fecha/hora del cuerpo del correo: Bancolombia varia
// el formato de "a las HH:MM" entre plantillas, pero el header Date del correo
// (received_at, lo manda el Apps Script) siempre es confiable. El parser solo
// extrae: tipo, monto, ultimos4 y una descripcion.

/**
 * "$150.000" -> 150000; "$150.000,50" -> 150000.5 (formato colombiano).
 * "$847,600.00" -> 847600 (los pagos por codigo QR usan formato con coma de
 * miles y punto decimal, al reves del resto de alertas). Se detecta cual de
 * los dos separadores es el decimal por cuantos digitos lo siguen (1-2 =
 * decimal, 3 = separador de miles); nunca se asume un formato fijo.
 */
export function parseCOPAmount(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{1,2}$/.test(s)) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Ultimos 4 digitos de tarjeta o cuenta, probando las frases mas comunes. */
function extractLast4(text) {
  const patterns = [
    /termin\w*\s+en\s*\*?(\d{4})\b/i,
    /cuenta\s*n[uú]mero\s*\*+(\d{4})\b/i,
    /cuenta\s*\*+(\d{4})\b/i,
    /producto\s*\*+(\d{4})\b/i,
    /\*(\d{4})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

// Palabras sueltas que a veces caen en la captura ("a la cuenta...", "en su cuenta...")
// y no sirven como descripcion.
const FILLER_WORDS = new Set(['la', 'el', 'los', 'las', 'su', 'tu', 'mi', 'una', 'un', 'de']);

/** Texto despues de "en "/"a "/"de " hasta la siguiente palabra de corte. */
function extractCounterpart(text) {
  // "el" exige un digito despues (la fecha: "...el 04/10/2026") para no
  // cortar nombres de comercio que traen la palabra "el" (p.ej. "EL EXITO").
  const STOP = '(?=\\s+(?:con\\b|tarjeta\\b|producto\\b|cuenta\\b|el\\s+\\d|a las\\b|desde\\b|\\.|,|$))';
  const tries = [
    new RegExp('\\ben\\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
    new RegExp('\\bde\\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
    new RegExp('\\ba\\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
  ];
  for (const re of tries) {
    const m = re.exec(text);
    if (m) {
      const val = m[1].replace(/\s+/g, ' ').trim();
      if (val && !/^\d+$/.test(val) && !FILLER_WORDS.has(val.toLowerCase())) return val;
    }
  }
  return null;
}

/**
 * Clasifica el tipo de alerta por su verbo ("Compraste", "Transferiste").
 * Bancolombia conjuga el verbo, no usa el sustantivo -> se detecta por la
 * raiz de la palabra. `lead` es solo el texto ANTES del monto: todos los
 * correos de Bancolombia repiten el mismo aviso de seguridad en el pie
 * ("Cuando compres, no pierdas de vista tu tarjeta...") sin importar el tipo
 * real del movimiento, así que mirar el correo completo clasificaria
 * cualquier alerta como compra. `around` es una ventana corta alrededor del
 * monto (antes y despues), donde Bancolombia sí pone la direccion real de
 * una transferencia ("...desde tu cuenta...").
 */
// Ventana del monto: la misma que usa classify. El pie del correo
// ("...tu tarjeta de crédito...") queda fuera y no puede decidir el tipo.
export const WINDOW_BEFORE = 40;
export const WINDOW_AFTER = 260;

// Tarjeta de crédito y cuenta de ahorros de Alejo. La regla es por número,
// no por cómo esté redactado el correo ("T.Cred *1887" no dice "tarjeta de crédito").
export const CREDIT_CARD_LAST4 = '1887';
export const SAVINGS_LAST4 = '8213';

// Frases de abono, solo en la ventana del monto. "una tarjeta de crédito"
// no cuenta: la "a" tiene que ser palabra, no la última letra de "una".
// En Postgres \b no es límite de palabra, así que esa frase tiene otra forma
// en el SQL (campo sql). El resto coincide letra por letra.
export const CARD_BLOCK_PATTERNS = [
  { reason: 'pago_tarjeta_propia', source: String.raw`para abonar a la deuda` },
  { reason: 'pago_tarjeta_propia', source: String.raw`abono a (?:tu |la )?tarjeta de cr[eé]dito` },
  {
    reason: 'pago_tarjeta_propia',
    source: String.raw`(?:^|[^A-Za-zÀ-ÿ0-9])a (?:tu |la )?tarjeta de cr[eé]dito`,
    sql: String.raw`(^|[^[:alnum:]])a (tu |la )?tarjeta de cr[eé]dito`,
  },
  { reason: 'pago_tarjeta_propia', source: String.raw`pago (?:a |de )(?:tu |la )?tarjeta de cr[eé]dito` },
];

// Pago 8213 → 1887. Se busca desde el inicio del correo hasta 260 caracteres
// después del monto: el *8213 puede ir bastante antes del valor. No se mira
// el pie, que queda más allá de ese corte.
export const SAVINGS_TO_CARD_SRC = String.raw`\*1887[\s\S]{0,220}\*8213|\*8213[\s\S]{0,220}\*1887`;

const CARD_BLOCK_RES = CARD_BLOCK_PATTERNS.map((p) => ({
  reason: p.reason,
  re: new RegExp(p.source, 'i'),
}));
const SAVINGS_TO_CARD_RE = new RegExp(SAVINGS_TO_CARD_SRC, 'i');

// "$59.900" o "COP59.900". El mismo texto va en el SQL para ubicar la ventana.
export const AMOUNT_SRC = String.raw`(?:\$|COP)\s*([0-9][0-9.,]*[0-9]|[0-9])`;
const AMOUNT_RE = new RegExp(AMOUNT_SRC);

function flat(rawText) {
  return String(rawText || '').replace(/\s+/g, ' ').trim();
}

/** Trozo alrededor del primer monto. Vacío si el correo no trae monto. */
export function alertWindow(rawText) {
  const text = flat(rawText);
  const m = AMOUNT_RE.exec(text);
  if (!m) return '';
  return text.slice(Math.max(0, m.index - WINDOW_BEFORE), m.index + WINDOW_AFTER);
}

/** Frase de abono o pago de la deuda, solo dentro de la ventana del monto. */
export function isOwnCardPayment(rawText) {
  const window = alertWindow(rawText);
  if (!window) return false;
  return CARD_BLOCK_RES.some((p) => p.reason === 'pago_tarjeta_propia' && p.re.test(window));
}

/** Abono o pago de la deuda de la tarjeta, mirando solo la ventana del monto. */
export function isCardSettlement(rawText) {
  return isOwnCardPayment(rawText);
}

/**
 * Por qué este correo no debe crear un movimiento solo, o null si puede.
 * Un reverso o una devolución, en cualquier tarjeta, no entra solo.
 * Un ingreso de la 1887 tampoco. Un pago desde la 8213 hacia la 1887
 * se detecta en el texto que va hasta 260 caracteres después del monto.
 */
export function cardBlockReason(rawText, parsed) {
  if (parsed?.ignored_reason === 'pago_tarjeta_propia') return 'pago_tarjeta_propia';
  if (parsed?.kind === 'reverso') return 'reverso';
  if (String(parsed?.last4 || '') === CREDIT_CARD_LAST4 && parsed?.type === 'income') {
    return 'ingreso_tarjeta_credito';
  }
  const text = flat(rawText);
  const amt = AMOUNT_RE.exec(text);
  if (!amt) return null;
  const head = text.slice(0, amt.index + WINDOW_AFTER);
  if (SAVINGS_TO_CARD_RE.test(head)) return 'pago_desde_8213';
  const window = text.slice(Math.max(0, amt.index - WINDOW_BEFORE), amt.index + WINDOW_AFTER);
  for (const p of CARD_BLOCK_RES) {
    if (p.re.test(window)) return p.reason;
  }
  return null;
}

/**
 * Lo que "Aprobar todas" no debe tocar. Vacío = la fila está lista.
 * Misma lista que el SQL: perfil, monto, categoría, tipo, y el bloqueo de tarjeta.
 */
export function batchSkipReasons(item) {
  const parsed = item?.parsed ?? null;
  const reasons = [];
  if (item?.status && item.status !== 'pending_review') reasons.push('estado');
  if (!item?.profile_id) reasons.push('perfil');
  if (!(Number(parsed?.amount) > 0)) reasons.push('monto');
  if (!parsed?.category_id) reasons.push('categoría');
  if (!parsed || !['income', 'expense'].includes(parsed.type)) reasons.push('tipo');
  const block = cardBlockReason(item?.raw_text || '', parsed);
  if (block && !reasons.includes(block)) reasons.push(block);
  return reasons;
}

function classify(lead, around) {
  const t = lead.toLowerCase();
  const w = around.toLowerCase();
  // "Reverso de compra" trae la palabra compra, pero es un ingreso.
  // Solo cuenta si está ANTES del monto. Si "devolución" va después
  // (en el detalle, cerca del valor), la compra sigue siendo compra.
  if (/\brevers|\bdevolu/.test(t)) {
    return { kind: 'reverso', type: 'income', label: 'Reverso o devolución' };
  }
  if (/\bcompr\w*/.test(t)) return { kind: 'compra', type: 'expense', label: 'Compra con tarjeta' };
  if (/\bretir\w*/.test(t)) return { kind: 'retiro', type: 'expense', label: 'Retiro' };
  if (/\bpag(?:o|ue|aste|ando)\b/.test(t)) return { kind: 'pago', type: 'expense', label: 'Pago' };

  const esTransferencia = /\btransfer\w*/.test(t);
  const recibida = /(ha recibido|recibiste|recibi[oó]|te transfirieron|te consignaron|abono|abonaron|consignaci[oó]n)/.test(w);
  const enviada = /(enviaste|enviad[ao]|envi[oó]|realizaste.*transfer\w*|desde (tu|su|mi) cuenta)/.test(w);
  if (esTransferencia && recibida) return { kind: 'transferencia_recibida', type: 'income', label: 'Transferencia recibida' };
  if (esTransferencia && enviada) return { kind: 'transferencia_enviada', type: 'expense', label: 'Transferencia enviada' };
  // Transferencia sin direccion clara: mejor no adivinar si es ingreso o
  // gasto (el signo importa) -> queda pendiente de revision.
  if (esTransferencia) return null;
  if (recibida) return { kind: 'ingreso', type: 'income', label: 'Ingreso' };
  return null;
}

/** Hay un monto en el correo -> parece movimiento (no extracto, aviso ni promocion). */
export function looksLikeTransaction(rawText) {
  return AMOUNT_RE.test(String(rawText || ''));
}

/**
 * @param {string} rawText - cuerpo del correo (texto plano)
 * @returns {{type:'income'|'expense', kind:string, amount:number, currency:'COP',
 *            last4:string|null, description:string} | null}
 */
export function parseBancolombiaAlert(rawText) {
  const text = flat(rawText);
  if (!text) return null;

  const amtMatch = AMOUNT_RE.exec(text);
  if (!amtMatch) return null;
  const amount = parseCOPAmount(amtMatch[1]);
  if (!amount) return null;

  // El verbo (compra/pago/retiro/transferencia) siempre va antes del monto
  // en las plantillas de Bancolombia; la tarjeta/cuenta y la direccion de la
  // transferencia van justo despues. Fuera de esa ventana es publicidad o el
  // aviso legal del pie, que no debe influir en la clasificacion.
  const lead = text.slice(0, amtMatch.index);
  const around = text.slice(Math.max(0, amtMatch.index - WINDOW_BEFORE), amtMatch.index + WINDOW_AFTER);

  const cls = classify(lead, around);
  if (!cls) return null;

  const last4 = extractLast4(around);
  const counterpart = extractCounterpart(around);

  return {
    type: cls.type,
    kind: cls.kind,
    amount,
    currency: 'COP',
    last4,
    description: counterpart || cls.label,
  };
}
