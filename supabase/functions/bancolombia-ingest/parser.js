// Parser de alertas de Bancolombia (correo -> movimiento).
// Nunca inventa datos: si no reconoce el formato devuelve null y el correo
// queda en finance_email_inbox para completar a mano.
//
// Deliberadamente NO usa fecha/hora del cuerpo del correo: Bancolombia varia
// el formato de "a las HH:MM" entre plantillas, pero el header Date del correo
// (received_at, lo manda el Apps Script) siempre es confiable. El parser solo
// extrae: tipo, monto, ultimos4 y una descripcion.

/** "$150.000" -> 150000; "$150.000,50" -> 150000.5 (formato numerico colombiano). */
export function parseCOPAmount(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Primer monto en pesos que aparezca en el texto ("$X"). */
function extractAmount(text) {
  const m = /\$\s*([0-9][0-9.,]*[0-9]|[0-9])/.exec(text);
  return m ? parseCOPAmount(m[1]) : null;
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

/** Texto despues de "en "/"a "/"de " hasta la siguiente palabra de corte. */
function extractCounterpart(text) {
  const STOP = '(?=\\s+(?:con\\b|tarjeta\\b|producto\\b|cuenta\\b|el\\b|a las\\b|desde\\b|\\.|,|$))';
  const tries = [
    new RegExp('\\ben\\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
    new RegExp('\\bde\\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
    new RegExp('\\ba\\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .,&\'()-]{1,60}?)' + STOP, 'i'),
  ];
  for (const re of tries) {
    const m = re.exec(text);
    if (m) {
      const val = m[1].replace(/\s+/g, ' ').trim();
      if (val && !/^\d+$/.test(val)) return val;
    }
  }
  return null;
}

/** Clasifica el tipo de alerta por sus palabras clave, en orden de prioridad. */
function classify(text) {
  const t = text.toLowerCase();
  if (/\bcompra\b/.test(t)) return { kind: 'compra', type: 'expense', label: 'Compra con tarjeta' };
  if (/\bretiro\b/.test(t)) return { kind: 'retiro', type: 'expense', label: 'Retiro' };
  if (/\bpago\b/.test(t)) return { kind: 'pago', type: 'expense', label: 'Pago' };
  const esTransferencia = /transferenc\w+/.test(t);
  const recibida = /(ha recibido|recibi[oó]|abono|consignaci[oó]n|le han transferido)/.test(t);
  const enviada = /(enviad[ao]|envi[oó]|realiz[oó].*transferencia|transferenci\w+.*desde su cuenta)/.test(t);
  if (esTransferencia && recibida) return { kind: 'transferencia_recibida', type: 'income', label: 'Transferencia recibida' };
  if (esTransferencia && enviada) return { kind: 'transferencia_enviada', type: 'expense', label: 'Transferencia enviada' };
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

  const cls = classify(text);
  if (!cls) return null;

  const amount = extractAmount(text);
  if (!amount) return null;

  const last4 = extractLast4(text);
  const counterpart = extractCounterpart(text);

  return {
    type: cls.type,
    kind: cls.kind,
    amount,
    currency: 'COP',
    last4,
    description: counterpart || cls.label,
  };
}
