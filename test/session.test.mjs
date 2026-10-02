import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
const session = await import('../public/js/session.js');

const account = (username, role = 'SCANNER') => ({ username, role, token: `tok-${username}` });

beforeEach(() => {
  store.clear();
  for (const name of ['anna', 'ben', 'cleo']) session.addAccount(account(name)); // cleo is active (added last)
});

test('addAccount makes the account active and replaces an older entry of the same name', () => {
  assert.equal(session.activeAccount().username, 'cleo');
  session.addAccount({ username: 'anna', role: 'SCANNER', token: 'tok-anna-2' });
  assert.equal(session.activeAccount().token, 'tok-anna-2');
  assert.equal(session.getAccounts().filter(a => a.username === 'anna').length, 1);
});

test('dropAccount removes an account and keeps the active one when another was dropped', () => {
  const { next } = session.dropAccount('anna');
  assert.deepEqual(session.getAccounts().map(a => a.username), ['ben', 'cleo']);
  assert.equal(session.activeAccount().username, 'cleo');
  assert.equal(next.username, 'cleo');
});

test('dropping the active account makes the first remaining one active', () => {
  session.switchAccount('ben');
  const { next } = session.dropAccount('ben');
  assert.deepEqual(session.getAccounts().map(a => a.username), ['anna', 'cleo']);
  assert.equal(session.activeAccount().username, 'anna');
  assert.equal(next.username, 'anna');
});

test('dropping the last account leaves nobody active', () => {
  session.dropAccount('anna');
  session.dropAccount('ben');
  const { next } = session.dropAccount('cleo');
  assert.equal(next, null);
  assert.deepEqual(session.getAccounts(), []);
  assert.equal(session.activeAccount(), null);
  assert.equal(session.activeToken(), null);
});

test('dropping an unknown account changes nothing', () => {
  const { next } = session.dropAccount('nobody');
  assert.equal(session.getAccounts().length, 3);
  assert.equal(next.username, 'cleo');
});

test('switchAccount only accepts known accounts', () => {
  session.switchAccount('anna');
  assert.equal(session.activeAccount().username, 'anna');
  session.switchAccount('ghost');
  assert.equal(session.activeAccount().username, 'anna');
});

test('removeActiveAccount (logout) moves on to the first remaining account', () => {
  const next = session.removeActiveAccount();
  assert.equal(next.username, 'anna');
  assert.deepEqual(session.getAccounts().map(a => a.username), ['anna', 'ben']);
});
