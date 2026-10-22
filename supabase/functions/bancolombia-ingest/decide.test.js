// Ejecutar con: node --test supabase/functions/bancolombia-ingest/decide.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNewAlert, planReplay } from './decide.js';

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

test('la 1887: el abono a la tarjeta no crea movimiento', () => {
  for (const moneda of ['Pesos', 'Dólares']) {
    const raw = `Bancolombia: Abono a tarjeta de crédito Mastercard **1887 en ${moneda}. `
      + 'Valor $76.056,27 el 21/10/2026.' + FOOTER;
    const plan = planNewAlert(raw);
    assert.equal(plan.createTransaction, false);
    assert.equal(plan.status, 'ignored');
    assert.equal(plan.reason, 'pago_tarjeta_propia');
    assert.equal(plan.parsed, null);
  }
});

test('la 1887: pagar la tarjeta (aunque el monto vaya en medio) no crea movimiento', () => {
  const samples = [
    'Bancolombia: Pagaste $76.056,27 a tu tarjeta de crédito Mastercard **1887 el 21/10/2026.' + FOOTER,
    'Bancolombia: Pago a la tarjeta de crédito *1887 por $8.953,44 en Dólares.' + FOOTER,
    'Debitamos de tu cuenta $76,056.27 para abonar a la deuda en Pesos de tu tarjeta de credito MASTER **1887.' + FOOTER,
  ];
  for (const raw of samples) {
    const plan = planNewAlert(raw);
    assert.equal(plan.createTransaction, false, raw);
    assert.equal(plan.status, 'ignored');
    assert.equal(plan.reason, 'pago_tarjeta_propia');
  }
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
