// Ejecutar con: node --test supabase/functions/bancolombia-ingest/decide.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickManualTwin, planNewAlert, planReplay } from './decide.js';

const FOOTER = ' Cuando compres, no pierdas de vista tu tarjeta.';

test('la 1887: una compra sí puede crear movimiento', () => {
  const raw = 'Bancolombia: Compraste COP59.900 en CapCut con tu T.Cred *1887, el 13/10/2026 a las 19:58.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, true);
  assert.equal(plan.parsed.kind, 'compra');
  assert.equal(plan.parsed.type, 'expense');
  assert.equal(plan.parsed.amount, 59900);
  assert.equal(plan.parsed.last4, '1887');
});

test('la 1887: un gasto en un comercio con esa tarjeta también cuenta', () => {
  const raw = 'Bancolombia: Pagaste $85.000 en NETFLIX con tu T.Cred *1887, el 21/10/2026 a las 09:00.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, true);
  assert.equal(plan.parsed.type, 'expense');
  assert.equal(plan.parsed.last4, '1887');
  assert.equal(plan.parsed.amount, 85000);
});

test('la 1887: el abono a la tarjeta no se crea solo y queda para revisar', () => {
  for (const moneda of ['Pesos', 'Dólares']) {
    const raw = `Bancolombia: Abono a tarjeta de crédito Mastercard **1887 en ${moneda}. `
      + 'Valor $76.056,27 el 21/10/2026.' + FOOTER;
    const plan = planNewAlert(raw);
    assert.equal(plan.createTransaction, false);
    assert.equal(plan.status, 'pending_review');
    assert.notEqual(plan.status, 'ignored');
  }
});

test('la 1887: pagar la tarjeta (aunque el monto vaya en medio) no se crea solo', () => {
  const samples = [
    'Bancolombia: Pagaste $76.056,27 a tu tarjeta de crédito Mastercard **1887 el 21/10/2026.' + FOOTER,
    'Bancolombia: Pago a la tarjeta de crédito *1887 por $8.953,44 en Dólares.' + FOOTER,
    'Debitamos de tu cuenta $76,056.27 para abonar a la deuda en Pesos de tu tarjeta de credito MASTER **1887.' + FOOTER,
  ];
  for (const raw of samples) {
    const plan = planNewAlert(raw);
    assert.equal(plan.createTransaction, false, raw);
    assert.equal(plan.status, 'pending_review', raw);
  }
});

test('Abono a tu T.Cred *1887 queda en revisión, no se crea solo', () => {
  const raw = 'Bancolombia: Abono a tu T.Cred *1887 por $76.056,27 el 21/10/2026 a las 08:12.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, false);
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.reason, 'ingreso_tarjeta_credito');
  assert.equal(plan.parsed.type, 'income');
  assert.equal(plan.parsed.last4, '1887');
});

test('Pagaste a tu T.Cred *1887 desde la cuenta *8213 no se crea como gasto', () => {
  const raw = 'Bancolombia: Pagaste $76.056,27 a tu T.Cred *1887 desde tu cuenta *8213 el 21/10/2026 a las 08:20.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, false);
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.reason, 'pago_desde_8213');
  assert.equal(plan.parsed.type, 'expense');
  assert.equal(plan.parsed.amount, 76056.27);
});

test('un reverso en la 1887 no se crea solo', () => {
  const raw = 'Bancolombia: Reverso de compra por $40.000 en tu T.Cred *1887 el 21/10/2026 a las 10:00.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, false);
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.reason, 'reverso');
  assert.equal(plan.parsed.kind, 'reverso');
});

test('una compra con "devolución" cerca del monto sí puede entrar sola', () => {
  const raw = 'Bancolombia: Compraste $45.000 en TIENDA con tu T.Deb *5076. '
    + 'La devolución de puntos se ve en la app el 21/10/2026 a las 15:00.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, true);
  assert.equal(plan.parsed.kind, 'compra');
  assert.equal(plan.parsed.last4, '5076');
});

test('un pago con *8213 lejos del monto no se crea como gasto', () => {
  const puente = 'x'.repeat(80);
  const raw = `Cuenta *8213 ${puente}Bancolombia: Pagaste $76.056,27 a tu T.Cred *1887 el 21/10/2026.`;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, false);
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.reason, 'pago_desde_8213');
});

test('"una tarjeta de crédito" cerca del monto no frena la compra', () => {
  const raw = 'Bancolombia: Compraste $18.000 en LIBRERIA con una tarjeta de crédito *5076 '
    + 'el 21/10/2026 a las 11:00.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, true);
  assert.equal(plan.parsed.kind, 'compra');
  assert.equal(plan.parsed.amount, 18000);
});

test('un reverso en otra tarjeta distinta de la 1887 tampoco se crea solo', () => {
  const raw = 'Bancolombia: Devolución por $15.000 en tu T.Deb *5076 el 21/10/2026 a las 12:00.' + FOOTER;
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, false);
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.reason, 'reverso');
  assert.equal(plan.parsed.last4, '5076');
});

test('el pie con "tarjeta de crédito" no frena una compra real', () => {
  const raw = 'Bancolombia: Compraste $12.900 en TIENDA LA ESQUINA con tu T.Deb *5076 el 21/10/2026 a las 16:39.'
    + ' Protege tu tarjeta de crédito.'
    + ' Aviso.'.repeat(80)
    + ' Pasa a tu tarjeta de crédito para abonar cuando quieras.';
  const plan = planNewAlert(raw);
  assert.equal(plan.createTransaction, true);
  assert.equal(plan.parsed.kind, 'compra');
  assert.equal(plan.parsed.last4, '5076');
});

test('dos compras iguales el mismo día no se enlazan al manual que ya tiene correo', () => {
  const a = { id: 'man-a' };
  const b = { id: 'man-b' };
  assert.equal(pickManualTwin([a, b], []), null);
  assert.equal(pickManualTwin([a, b], ['man-a']).id, 'man-b');
  assert.equal(pickManualTwin([a, b], ['man-a', 'man-b']), null);
  assert.equal(pickManualTwin([a], ['man-a']), null);
  assert.equal(pickManualTwin([a], []).id, 'man-a');
  assert.equal(pickManualTwin([], []), null);
});

test('un correo que ya está en la bandeja no se crea otra vez, ni automático ni al reenviarlo', () => {
  const pending = planReplay({ status: 'pending_review', gmail_message_id: 'msg-1' });
  assert.equal(pending.createTransaction, false);
  assert.equal(pending.reason, 'ya_en_bandeja');
  assert.equal(pending.status, 'pending_review');

  const applied = planReplay({ status: 'applied', transaction_id: 'tx-1' });
  assert.equal(applied.createTransaction, false);
  assert.equal(applied.reason, 'duplicado');

  const ignored = planReplay({ status: 'ignored' });
  assert.equal(ignored.createTransaction, false);

  assert.equal(planReplay(null), null);
});

test('la misma compra, si el correo es nuevo, sí puede entrar sola; si ya está pendiente, no', () => {
  const raw = 'Bancolombia: Compraste COP23.500 en PARAMOUNT+ con tu T.Cred *1887, el 07/10/2026 a las 21:02.' + FOOTER;
  const nuevo = planNewAlert(raw);
  assert.equal(nuevo.createTransaction, true);
  assert.equal(nuevo.parsed.last4, '1887');

  const yaEnBandeja = planReplay({ status: 'pending_review' });
  assert.equal(yaEnBandeja.createTransaction, false);
  assert.notEqual(nuevo.createTransaction, yaEnBandeja.createTransaction);
});
