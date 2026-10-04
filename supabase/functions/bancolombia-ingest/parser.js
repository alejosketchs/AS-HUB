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
function classify(lead, around) {
  const t = lead.toLowerCase();
  if (/\bcompr\w*/.test(t)) return { kind: 'compra', type: 'expense', label: 'Compra con tarjeta' };
  if (/\bretir\w*/.test(t)) return { kind: 'retiro', type: 'expense', label: 'Retiro' };
  if (/\bpag(?:o|ue|aste|ando)\b/.test(t)) return { kind: 'pago', type: 'expense', label: 'Pago' };

  const esTransferencia = /\btransfer\w*/.test(t);
  const w = around.toLowerCase();
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

/**
 * @param {string} rawText - cuerpo del correo (texto plano)
 * @returns {{type:'income'|'expense', kind:string, amount:number, currency:'COP',
 *            last4:string|null, description:string} | null}
 */
export function parseBancolombiaAlert(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const amtMatch = /\$\s*([0-9][0-9.,]*[0-9]|[0-9])/.exec(text);
  if (!amtMatch) return null;
  const amount = parseCOPAmount(amtMatch[1]);
  if (!amount) return null;

  // El verbo (compra/pago/retiro/transferencia) siempre va antes del monto
  // en las plantillas de Bancolombia; la tarjeta/cuenta y la direccion de la
  // transferencia van justo despues. Fuera de esa ventana es publicidad o el
  // aviso legal del pie, que no debe influir en la clasificacion.
  const lead = text.slice(0, amtMatch.index);
  const around = text.slice(Math.max(0, amtMatch.index - 40), amtMatch.index + 260);

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
