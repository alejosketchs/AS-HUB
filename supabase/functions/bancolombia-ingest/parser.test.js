// Ejecutar con: node --test supabase/functions/bancolombia-ingest/parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCOPAmount, parseBancolombiaAlert } from './parser.js';

test('parseCOPAmount: formato colombiano sin decimales', () => {
  assert.equal(parseCOPAmount('150.000'), 150000);
  assert.equal(parseCOPAmount('1.250.000'), 1250000);
});

test('parseCOPAmount: formato colombiano con decimales', () => {
  assert.equal(parseCOPAmount('150.000,50'), 150000.5);
});

test('parseCOPAmount: valores invalidos', () => {
  assert.equal(parseCOPAmount(''), null);
  assert.equal(parseCOPAmount('0'), null);
  assert.equal(parseCOPAmount('abc'), null);
});

test('compra con tarjeta', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia le informa Compra por $150.000 a las 14:35 en ALMACENES EXITO '
    + 'con Tarjeta terminada en 1234. Si no reconoce esta transaccion comuniquese al 018000.',
  );
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'compra');
  assert.equal(r.amount, 150000);
  assert.equal(r.last4, '1234');
  assert.match(r.description, /EXITO/i);
});

test('pago de servicio con tarjeta', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia le informa Pago por $85.000 a las 09:00 en NETFLIX COM con Tarjeta terminada en 5678.',
  );
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'pago');
  assert.equal(r.amount, 85000);
  assert.equal(r.last4, '5678');
});

test('retiro en cajero', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia le informa Retiro por $300.000 a las 16:00 en CAJERO AUTOMATICO BANCOLOMBIA '
    + 'con Tarjeta terminada en 1234.',
  );
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'retiro');
  assert.equal(r.amount, 300000);
});

test('transferencia enviada', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia le informa que se realizo una Transferencia por $200.000 desde su cuenta *4567 '
    + 'a la cuenta de JUAN PEREZ el 04/10/2026 a las 10:12.',
  );
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'transferencia_enviada');
  assert.equal(r.amount, 200000);
  assert.equal(r.last4, '4567');
});

test('transferencia recibida (ingreso)', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia le informa que ha recibido una Transferencia por $500.000 en su cuenta *4567 '
    + 'el 04/10/2026 a las 11:00 de MARIA GOMEZ.',
  );
  assert.ok(r);
  assert.equal(r.type, 'income');
  assert.equal(r.kind, 'transferencia_recibida');
  assert.equal(r.amount, 500000);
  assert.equal(r.last4, '4567');
});

test('formato desconocido devuelve null (nunca inventa datos)', () => {
  assert.equal(parseBancolombiaAlert('Su extracto mensual ya esta disponible.'), null);
  assert.equal(parseBancolombiaAlert(''), null);
  assert.equal(parseBancolombiaAlert('Compra realizada pero sin monto visible.'), null);
});
