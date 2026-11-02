// Ejecutar con: node --test js/finance-totals.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealExpense, totals, withoutIgnored } from './finance-totals.js';

const tx = (over) => ({
  id: 'x', type: 'expense', amount: 10000, spend_type: 'variable', reimbursable: false, ignored: false, ...over,
});

const list = [
  tx({ id: 'mecato', amount: 20000 }),
  tx({ id: 'goceto', amount: 38200 }),
  // Transferencia entre cuentas propias marcada como ignorada.
  tx({ id: 'transfer', amount: 250000, ignored: true }),
  tx({ id: 'arriendo', amount: 900000, spend_type: 'fixed' }),
  tx({ id: 'sueldo', type: 'income', amount: 3000000, spend_type: 'income' }),
  tx({ id: 'ingreso-ignorado', type: 'income', amount: 500000, spend_type: 'income', ignored: true }),
  tx({ id: 'ahorro', type: 'saving', amount: 100000, spend_type: 'saving' }),
  tx({ id: 'ahorro-ignorado', type: 'saving', amount: 70000, spend_type: 'saving', ignored: true }),
  tx({ id: 'retiro-ignorado', type: 'withdrawal', amount: 40000, spend_type: 'saving', ignored: true }),
  tx({ id: 'reembolso-ignorado', amount: 60000, reimbursable: true, ignored: true }),
  tx({ id: 'devolucion', type: 'income', amount: 15000, category_id: 'refund-cat' }),
];

test('los totales excluyen los movimientos ignorados', () => {
  const t = totals(list, { refundCatId: 'refund-cat' });
  assert.equal(t.expense, 20000 + 38200 + 900000);
  assert.equal(t.variable, 20000 + 38200);
  assert.equal(t.fixed, 900000);
  assert.equal(t.income, 3000000); // sin el ignorado ni la devolución
  assert.equal(t.saving, 100000);
  assert.equal(t.cashIn, 3000000 + 15000);
  assert.equal(t.cashOut, 20000 + 38200 + 900000 + 100000);
});

test('ignorar o des-ignorar mueve los totales', () => {
  const before = totals(list).cashOut;
  const unignored = list.map((t) => (t.id === 'transfer' ? { ...t, ignored: false } : t));
  assert.equal(totals(unignored).cashOut, before + 250000);
});

test('sin la columna ignored (antes de la migración) todo cuenta', () => {
  const legacy = [{ type: 'expense', amount: 5000, spend_type: 'variable' }];
  assert.equal(totals(legacy).expense, 5000);
});

test('predicados y withoutIgnored dejan fuera lo ignorado', () => {
  assert.equal(isRealExpense(tx({ ignored: true })), false);
  assert.deepEqual(withoutIgnored(list).map((t) => t.id).includes('transfer'), false);
  assert.equal(withoutIgnored(list).length, list.length - 5);
});
