// Ejecutar con: node --test supabase/functions/bancolombia-ingest/parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alertWindow, AMOUNT_SRC, batchSkipReasons, CARD_BLOCK_PATTERNS, cardBlockReason, CREDIT_CARD_LAST4,
  isCardSettlement, isOwnCardPayment, looksLikeTransaction, parseCOPAmount, parseBancolombiaAlert,
  SAVINGS_TO_CARD_SRC, WINDOW_AFTER, WINDOW_BEFORE,
} from './parser.js';
import { isCardSettlement as isCardSettlementApp, isOwnCardPayment as isOwnCardPaymentApp } from '../../../js/bancolombia-text.js';

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

test('compra con monto en formato COP (tarjeta de credito)', () => {
  const r = parseBancolombiaAlert(
    'Bancolombia: Compraste COP59.900,00 en CapCut con tu T.Cred *1887, el 13/10/2026 a las 19:58.' + FOOTER,
  );
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(r.kind, 'compra');
  assert.equal(r.amount, 59900);
  assert.equal(r.last4, '1887');
  assert.equal(r.description, 'CapCut');
});

test('COP59.900 y COP23.500 sin decimales (el monto va pegado al codigo)', () => {
  const capcut = parseBancolombiaAlert(
    'Bancolombia: Compraste COP59.900 en CapCut con tu T.Cred *1887, el 13/10/2026 a las 19:58.' + FOOTER,
  );
  assert.ok(capcut);
  assert.equal(capcut.amount, 59900);
  assert.equal(capcut.last4, '1887');
  assert.equal(capcut.description, 'CapCut');

  const paramount = parseBancolombiaAlert(
    'Bancolombia: Compraste COP23.500 en PARAMOUNT+ con tu T.Cred *1887, el 07/10/2026 a las 21:02.' + FOOTER,
  );
  assert.ok(paramount);
  assert.equal(paramount.type, 'expense');
  assert.equal(paramount.amount, 23500);
  assert.equal(paramount.last4, '1887');
});

test('looksLikeTransaction reconoce "$" y "COP"', () => {
  assert.equal(looksLikeTransaction('Compraste COP23.500,00 en PARAMOUNT+'), true);
  assert.equal(looksLikeTransaction('Compraste $23.500 en PARAMOUNT+'), true);
  assert.equal(looksLikeTransaction('Llego tu extracto del mes'), false);
});

test('abono a tarjeta de credito desde ahorros NO es un gasto nuevo', () => {
  for (const moneda of ['Pesos', 'Dólares']) {
    const raw = `Bancolombia: Debitamos de tu cuenta/bolsillo $76,056.27 para abonar a la deuda en en ${moneda}. `
      + 'de tu tarjeta de credito MASTER **1887. Encontraras el abono el proximo dia habil.' + FOOTER;
    assert.equal(isOwnCardPayment(raw), true);
    const parsed = parseBancolombiaAlert(raw);
    assert.equal(parsed?.last4, '1887');
    assert.equal(parsed?.type, 'income');
    assert.equal(cardBlockReason(raw, parsed), 'ingreso_tarjeta_credito');
  }
});

test('una frase de abono lejos del monto no se lee en el pie ni fuera de la ventana', () => {
  const pesos = 'Bancolombia te informa: Abono a tarjeta de crédito Mastercard **1887 en Pesos. '
    + 'Se debitó de tu cuenta de ahorros. El detalle del movimiento, que verás reflejado '
    + 'el siguiente día hábil en el cupo, corresponde a un valor de $76.056,27 el 21/10/2026 a las 08:12.'
    + FOOTER;
  assert.equal(isOwnCardPayment(pesos), false);
  assert.equal(isCardSettlement(pesos), false);
});

test('la app y el parser coinciden en qué es pago de tarjeta propia', () => {
  const samples = [
    'Abono a tu tarjeta de crédito en Pesos $10.000',
    'Abono a la tarjeta de crédito en Dólares',
    'Pagaste $76.056,27 a tu tarjeta de crédito *1887',
    'Pago a la tarjeta de crédito Mastercard *1887 por $10.000',
    'Compraste COP59.900 en CapCut con tu T.Cred *1887',
    'Pagaste $85.000 en NETFLIX con tu T.Cred *1887',
    'Te abonaron $120.000 en tu cuenta',
    '',
  ];
  for (const raw of samples) {
    assert.equal(isOwnCardPaymentApp(raw), isOwnCardPayment(raw));
    assert.equal(isCardSettlementApp(raw), isCardSettlement(raw));
  }
});

test('el pie con "tarjeta de crédito" no convierte una compra en pago de la tarjeta', () => {
  const cerca = ' Protege tu tarjeta de crédito. No la prestes.';
  const lejos = ' Texto de relleno del aviso legal.'.repeat(30)
    + ' Si vas a tu tarjeta de crédito para abonar, revisa el cupo.';
  const raw = 'Bancolombia: Compraste $7.500,00 en CAFE EL AROMA con tu T.Deb *1234, el 29/09/2026 a las 19:06.'
    + cerca + lejos;
  assert.equal(isCardSettlement(raw), false);
  assert.equal(isCardSettlementApp(raw), false);
  assert.equal(cardBlockReason(raw, null), null);
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.kind, 'compra');
  assert.equal(r.amount, 7500);
  assert.equal(r.last4, '1234');
});

test('Abono a tu T.Cred *1887 se reconoce como ingreso de esa tarjeta', () => {
  const raw = 'Bancolombia: Abono a tu T.Cred *1887 por $76.056,27 el 21/10/2026 a las 08:12.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'income');
  assert.equal(r.last4, '1887');
  assert.equal(r.amount, 76056.27);
  assert.equal(isCardSettlement(raw), false);
  assert.equal(cardBlockReason(raw, r), 'ingreso_tarjeta_credito');
});

test('Pagaste a tu T.Cred *1887 desde la cuenta *8213 no es un gasto', () => {
  const raw = 'Bancolombia: Pagaste $76.056,27 a tu T.Cred *1887 desde tu cuenta *8213 el 21/10/2026 a las 08:20.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'expense');
  assert.equal(cardBlockReason(raw, r), 'pago_desde_8213');
  assert.equal(isCardSettlement(raw), false);
});

test('reverso en la 1887 es un ingreso y no una compra', () => {
  const raw = 'Bancolombia: Reverso de compra por $40.000 en tu T.Cred *1887 el 21/10/2026 a las 10:00.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.type, 'income');
  assert.equal(r.kind, 'reverso');
  assert.equal(r.last4, '1887');
  assert.equal(r.amount, 40000);
  assert.equal(cardBlockReason(raw, r), 'reverso');
});

test('Aprobar todas usa los mismos patrones, la misma ventana y los mismos campos', () => {
  const sql = readFileSync(new URL('../../../docs/migracion-bandeja-aprobar-2026-10.sql', import.meta.url), 'utf8');
  const found = [...sql.matchAll(/~\*\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(found, [
    ...CARD_BLOCK_PATTERNS.map((p) => p.sql || p.source),
    SAVINGS_TO_CARD_SRC,
  ]);
  assert.match(sql, /substr\(v_text, 1, v_at \+ 260\)/);
  assert.match(sql, /parsed->>'kind' = 'reverso'/);
  assert.ok(sql.includes(AMOUNT_SRC));
  assert.match(sql, new RegExp(`v_at - ${WINDOW_BEFORE}`));
  assert.match(sql, new RegExp(`v_at \\+ ${WINDOW_AFTER}`));
  assert.match(sql, /r\.profile_id is null/);
  assert.match(sql, /coalesce\(\(r\.parsed->>'amount'\)::numeric, 0\) <= 0/);
  assert.match(sql, /nullif\(r\.parsed->>'category_id', ''\) is null/);
  assert.match(sql, /not in \('income', 'expense'\)/);
  assert.match(sql, new RegExp(`parsed->>'last4', ''\\) = '${CREDIT_CARD_LAST4}'`));
  assert.match(sql, /parsed->>'type', ''\) = 'income'/);
  const listo = {
    status: 'pending_review', profile_id: 'alejo',
    raw_text: 'Compraste $10.000 en TIENDA con tu T.Deb *5076',
    parsed: { amount: 10000, category_id: 'cat', type: 'expense', last4: '5076' },
  };
  assert.deepEqual(batchSkipReasons(listo), []);
  assert.ok(batchSkipReasons({ ...listo, profile_id: null }).includes('perfil'));
  assert.ok(batchSkipReasons({ ...listo, parsed: { ...listo.parsed, amount: 0 } }).includes('monto'));
  assert.ok(batchSkipReasons({ ...listo, parsed: { ...listo.parsed, category_id: '' } }).includes('categoría'));
  assert.ok(batchSkipReasons({ ...listo, parsed: { ...listo.parsed, type: 'saving' } }).includes('tipo'));
  const abono = {
    ...listo,
    raw_text: 'Abono a tu T.Cred *1887 por $10.000',
    parsed: { amount: 10000, category_id: 'cat', type: 'income', last4: '1887' },
  };
  assert.ok(batchSkipReasons(abono).includes('ingreso_tarjeta_credito'));
  const reverso = {
    ...listo,
    parsed: { ...listo.parsed, kind: 'reverso', type: 'income', last4: '5076' },
  };
  assert.ok(batchSkipReasons(reverso).includes('reverso'));
});

test('una compra con "devolución" después del monto sigue siendo compra', () => {
  const raw = 'Bancolombia: Compraste $45.000 en TIENDA con tu T.Deb *5076. '
    + 'La devolución de puntos se ve en la app el 21/10/2026 a las 15:00.' + FOOTER;
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.kind, 'compra');
  assert.equal(r.type, 'expense');
  assert.equal(r.last4, '5076');
  assert.equal(cardBlockReason(raw, r), null);
});

test('un pago con *8213 lejos del monto, antes del valor, no se crea como gasto', () => {
  const puente = 'x'.repeat(80);
  const raw = `Cuenta *8213 ${puente}Bancolombia: Pagaste $76.056,27 a tu T.Cred *1887 el 21/10/2026.`;
  assert.equal(alertWindow(raw).includes('*8213'), false);
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(cardBlockReason(raw, r), 'pago_desde_8213');
  const pie = 'Compraste $10.000 en TIENDA con tu T.Cred *1887 el 21/10/2026.'
    + `${' aviso'.repeat(80)} cuenta *8213`;
  assert.equal(cardBlockReason(pie, parseBancolombiaAlert(pie)), null);
});

test('"una tarjeta de crédito" cerca del monto no es un pago de la tarjeta', () => {
  const raw = 'Bancolombia: Compraste $18.000 en LIBRERIA con una tarjeta de crédito *5076 '
    + 'el 21/10/2026 a las 11:00.' + FOOTER;
  assert.equal(isCardSettlement(raw), false);
  assert.equal(isOwnCardPayment(raw), false);
  const r = parseBancolombiaAlert(raw);
  assert.ok(r);
  assert.equal(r.kind, 'compra');
  assert.equal(cardBlockReason(raw, r), null);
  assert.equal(isCardSettlement('Pagaste $10.000 a tu tarjeta de crédito *1887'), true);
});

test('un abono que no es pago de la tarjeta propia sigue pudiendo ser ingreso', () => {
  assert.equal(isOwnCardPayment('Te abonaron $120.000 en tu cuenta'), false);
  const r = parseBancolombiaAlert(
    'Bancolombia le informa que ha recibido una Transferencia por $120.000 en su cuenta *4567 '
    + 'el 21/10/2026 a las 11:00 de MARIA GOMEZ. Te abonaron.' + FOOTER,
  );
  assert.ok(r);
  assert.equal(r.type, 'income');
  assert.equal(r.amount, 120000);
});
