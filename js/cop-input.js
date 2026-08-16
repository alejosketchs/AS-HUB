export function digitsCOP(value) {
  return String(value ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

export function parseCOP(value) {
  const digits = digitsCOP(value);
  return digits ? Number(digits) : 0;
}

export function formatCOPInput(value) {
  const digits = digitsCOP(value);
  return digits ? `$${Number(digits).toLocaleString('es-CO')}` : '';
}

export function bindCOPInput(input) {
  input.value = formatCOPInput(input.value);
  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, '').length;
    const formatted = formatCOPInput(input.value);
    input.value = formatted;

    if (!formatted || !digitsBeforeCaret) {
      input.setSelectionRange(formatted.length, formatted.length);
      return;
    }

    let seen = 0;
    let nextCaret = formatted.length;
    for (let i = 0; i < formatted.length; i += 1) {
      if (/\d/.test(formatted[i])) seen += 1;
      if (seen === digitsBeforeCaret) {
        nextCaret = i + 1;
        break;
      }
    }
    input.setSelectionRange(nextCaret, nextCaret);
  });
}
