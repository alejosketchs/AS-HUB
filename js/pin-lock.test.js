// Ejecutar con: node --test js/pin-lock.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLock, isUnlocked, unlock, lock, LOCK_KEY } from './pin-lock.js';

const memoria = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('sin nada guardado está bloqueado', () => {
  const s = memoria();
  assert.equal(readLock(s), null);
  assert.equal(isUnlocked(readLock(s)), false);
});

test('desbloquear dura los días pedidos y luego vence', () => {
  const s = memoria();
  const t0 = Date.UTC(2026, 9, 28);
  unlock(s, 'alejo', 30, t0);
  const st = readLock(s);
  assert.equal(st.profileId, 'alejo');
  assert.equal(isUnlocked(st, t0 + 29 * 864e5), true);
  assert.equal(isUnlocked(st, t0 + 30 * 864e5 + 1), false);
});

test('lock borra el desbloqueo', () => {
  const s = memoria();
  unlock(s, 'manuela', 30);
  lock(s);
  assert.equal(readLock(s), null);
});

test('datos dañados cuentan como bloqueado', () => {
  const s = memoria();
  s.setItem(LOCK_KEY, '{no es json');
  assert.equal(readLock(s), null);
  s.setItem(LOCK_KEY, JSON.stringify({ profileId: 1, until: 'x' }));
  assert.equal(readLock(s), null);
});
