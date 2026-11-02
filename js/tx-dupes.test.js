// Ejecutar con: node --test js/tx-dupes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, findAutomaticTwins, findDuplicatePairs, sameAmount } from './tx-dupes.js';

const auto = (over) => ({
  id: 'auto-1',
  source: 'automatico',
  profile_id: 'alejo',
  type: 'expense',
  amount: 847600,
  transaction_date: '2026-09-29',
  description: 'Convergencia Motos',
  ...over,
});

const manual = (over) => ({
  id: 'manual-1',
  source: 'manual',
  profile_id: 'alejo',
  type: 'expense',
  amount: '847600.00',
  transaction_date: '2026-09-29',
  description: 'Taller moto',
  ...over,
});

test('sameAmount acepta número y texto con decimales .00', () => {
  assert.equal(sameAmount(847600, '847600.00'), true);
  assert.equal(sameAmount('76056.27', 76056.27), true);
  assert.equal(sameAmount(100, 100.5), false);
  assert.equal(sameAmount('abc', 10), false);
});

test('daysBetween cuenta días de calendario y no depende de la hora', () => {
  assert.equal(daysBetween('2026-09-29', '2026-09-28'), -1);
  assert.equal(daysBetween('2026-09-29T23:00:00Z', '2026-09-30'), 1);
  assert.equal(daysBetween('2026-09-29', '2026-10-01'), 2);
  assert.equal(daysBetween('', '2026-09-29'), null);
});

test('al guardar a mano, un automático del mismo perfil, monto y tipo a ±1 día es el mismo', () => {
  const rows = [
    auto({}),
    auto({ id: 'otro-dia', transaction_date: '2026-09-27', amount: 847600 }),
    auto({ id: 'otro-perfil', profile_id: 'shori' }),
    auto({ id: 'otro-tipo', type: 'income' }),
    auto({ id: 'otro-monto', amount: 1000 }),
    manual({ id: 'ya-manual', source: 'manual' }),
  ];
  const hit = findAutomaticTwins(rows, {
    profile_id: 'alejo', type: 'expense', amount: 847600, transaction_date: '2026-09-30',
  });
  assert.deepEqual(hit.map((t) => t.id), ['auto-1']);

  const mismoDia = findAutomaticTwins(rows, {
    profile_id: 'alejo', type: 'expense', amount: '847600.00', transaction_date: '2026-09-29',
  });
  assert.deepEqual(mismoDia.map((t) => t.id), ['auto-1']);

  const lejos = findAutomaticTwins(rows, {
    profile_id: 'alejo', type: 'expense', amount: 847600, transaction_date: '2026-10-01',
  });
  assert.deepEqual(lejos, []);
});

test('la vista de posibles duplicados lista pares y no borra ni empareja dos manuales', () => {
  const rows = [
    auto({ id: 'a1', transaction_date: '2026-09-29', description: 'Convergencia Motos' }),
    manual({ id: 'm1', transaction_date: '2026-09-28', description: 'Taller moto' }),
    manual({ id: 'm2', source: 'manual', amount: 100, transaction_date: '2026-09-29', description: 'Otro' }),
    auto({ id: 'a2', amount: 100, transaction_date: '2026-09-29', description: 'Tienda' }),
    { id: 'viejo', profile_id: 'alejo', type: 'expense', amount: 100, transaction_date: '2026-09-29', description: 'Sin source' },
  ];
  const pairs = findDuplicatePairs(rows);
  assert.equal(pairs.length, 3);
  const keys = pairs.map((p) => `${p.manual.id}+${p.automatic.id}`);
  assert.ok(keys.includes('m1+a1'));
  assert.ok(keys.includes('m2+a2'));
  assert.ok(keys.includes('viejo+a2'));
  assert.equal(pairs.some((p) => p.manual.id === 'm1' && p.days === 1), true);
});
