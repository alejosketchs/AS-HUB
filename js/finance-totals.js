// AS HUB — sumas de movimientos (sin DOM, para poder probarlas con node --test).
// Un movimiento ignorado (ignored = true) no cuenta en ninguna suma: ni
// totales, ni gráficas, ni presupuestos, ni saldo. Sigue en la lista, atenuado.

export const counts = (t) => !t.ignored;
export const withoutIgnored = (list) => list.filter(counts);

const n = (v) => Number(v) || 0;
const amt = (x) => n(x.amount);
const sumBy = (list, f) => list.reduce((acc, x) => acc + n(f(x)), 0);

export const isIncome = (t) => counts(t) && t.type === 'income';
export const isExpense = (t) => counts(t) && t.type === 'expense';
export const isSaving = (t) => counts(t) && t.type === 'saving';
export const isWithdrawal = (t) => counts(t) && t.type === 'withdrawal';
export const isReimbursable = (t) => isExpense(t) && !!t.reimbursable;
export const isRealExpense = (t) => isExpense(t) && !t.reimbursable;
export const isFixedTx = (t) => isRealExpense(t) && t.spend_type === 'fixed';
export const isVarTx = (t) => isRealExpense(t) && t.spend_type !== 'fixed';

/** refundCatId: categoría de "reembolso recibido" (no cuenta como ingreso real). */
export function totals(list, { refundCatId = null } = {}) {
  const isRefund = (t) => isIncome(t) && !!refundCatId && t.category_id === refundCatId;
  const isRealIncome = (t) => isIncome(t) && !isRefund(t);
  return {
    income: sumBy(list.filter(isRealIncome), amt),
    expense: sumBy(list.filter(isRealExpense), amt),
    fixed: sumBy(list.filter(isFixedTx), amt),
    variable: sumBy(list.filter(isVarTx), amt),
    saving: sumBy(list.filter(isSaving), amt) - sumBy(list.filter(isWithdrawal), amt),
    cashIn: sumBy(list.filter((t) => isIncome(t) || isWithdrawal(t)), amt),
    cashOut: sumBy(list.filter((t) => isExpense(t) || isSaving(t)), amt),
  };
}
