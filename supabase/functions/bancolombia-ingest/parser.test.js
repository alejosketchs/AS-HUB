// Ejecutar con: node --test supabase/functions/bancolombia-ingest/parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCOPAmount, parseBancolombiaAlert } from './parser.js';

// El pie de pagina real de Bancolombia repite este aviso en TODOS sus
// correos (compras, pagos, retiros, transferencias por igual). Si el parser
// lo mirara, clasificaria cualquier alerta como "compra".
const FOOTER = ' Esto es un mensaje automatico. Por favor, no contestes. '
  + 'Tu seguridad es nuestra prioridad: Protege tus datos. No des informacion '
  + 'confidencial por llamadas o enlaces de correos. Cuando compres, no pierdas '
  + 'de vista tu tarjeta. Revisa que si sea la tuya. Vigilado Superintendencia '
  + 'Financiera de Colombia.';

test('parseCOPAmount: formato colombiano sin decimales', () => {
  assert.equal(parseCOPAmount('150.000'), 150000);
  assert.equal(parseCOPAmount('1.250.000'), 1250000);
});

test('parseCOPAmount: formato colombiano con decimales', () => {
  assert.equal(parseCOPAmount('150.000,50'), 150000.5);
});

test('parseCOPAmount: estilo con coma de miles (sin decimales)', () => {
  assert.equal(parseCOPAmount('95,000'), 95000);
});

test('parseCOPAmount: estilo con coma de miles y punto decimal (pagos QR)', () => {
  assert.equal(parseCOPAmount('847,600.00'), 847600);
  assert.equal(parseCOPAmount('1,234.56'), 1234.56);
});

test('parseCOPAmount: valores invalidos', () => {
  assert.equal(parseCOPAmount(''), null);
  assert.equal(parseCOPAmount('0'), null);
  assert.equal(parseCOPAmount('abc'), null);
});

test('correo real: compra con tarjeta debito (incluye pie de pagina completo)', () => {
  const raw = '¡Listo! Todo salio bien con tus movimientos Bancolombia: Compraste $7.500,00 en '
    + 'CAFE EL AROMA con tu T.Deb *1234, el 29/09/2026 a las 19:06. Si tienes dudas, '
    + 'encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'compra');
  assert.equal(r.amount, 7500);
  assert.equal(r.last4, '1234');
  assert.match(r.description, /CAFE EL AROMA/);
});

test('correo real: compra con nombre de comercio que termina en una preposicion', () => {
  const raw = '¡Listo! Todo salio bien con tus movimientos Bancolombia: Compraste $12.900,00 en '
    + 'TIENDA LA ESQUINA DE con tu T.Deb *1234, el 29/09/2026 a las 16:39.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'compra');
  assert.equal(r.amount, 12900);
  assert.equal(r.last4, '1234');
});

test('correo real: transferencia enviada entre cuentas (verbo conjugado, sin la palabra "transferencia")', () => {
  const raw = '¡Listo! Todo salio bien con tus movimientos Bancolombia: Transferiste $95,000 '
    + 'desde tu cuenta *4321 a la cuenta *99998888777 el 29/09/2026 a las 17:25. '
    + '¿Dudas? Llamanos al 018000931987.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'transferencia_enviada');
  assert.equal(r.amount, 95000);
  assert.equal(r.last4, '4321');
});

test('correo real: pago por codigo QR (monto en formato coma-miles/punto-decimal)', () => {
  const raw = '¡Listo! Todo salio bien con tus movimientos Bancolombia: JUAN PEREZ GOMEZ '
    + 'pagaste $847,600.00 por codigo QR desde tu cuenta *4321 a la llave '
    + '@tiendaficticia el 29/09/2026 a las 12:32. Con codigo QR es facil y de una.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'pago');
  assert.equal(r.amount, 847600);
  assert.equal(r.last4, '4321');
});

test('el pie de pagina por si solo (sin monto) nunca se confunde con una compra', () => {
  assert.equal(parseBancolombiaAlert(FOOTER), null);
});

test('transferencia sin direccion clara no inventa si es ingreso o gasto', () => {
  const raw = 'Bancolombia: Transferencia por $200.000 procesada el 04/10/2026.' + FOOTER;
  assert.equal(parseBancolombiaAlert(raw), null);
});

test('compra con plantilla generica (tarjeta terminada en)', () => {
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

test('transferencia enviada (plantilla generica)', () => {
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
