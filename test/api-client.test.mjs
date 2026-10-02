import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// the client modules read localStorage lazily; give them an in-memory one
const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
const { api } = await import('../public/js/api.js');
const { setLang } = await import('../public/js/i18n.js');

function respond(status, body) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('not json');
      return body;
    },
  });
}

beforeEach(() => { store.clear(); setLang('en'); });

test('an error with a known code is translated into the current language', async () => {
  respond(400, { error: 'Invalid JSON', code: 'INVALID_JSON' });
  await assert.rejects(api.get('/x'), err => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_JSON');
    assert.equal(err.message, 'The request was not valid JSON.');
    return true;
  });

  setLang('de');
  await assert.rejects(api.get('/x'), err => err.message === 'Ungültige Anfrage (kein gültiges JSON).');
});

test('an unknown code falls back to the server text', async () => {
  respond(409, { error: 'Server says no', code: 'SOMETHING_NEW' });
  await assert.rejects(api.post('/x', {}), err => err.message === 'Server says no' && err.code === 'SOMETHING_NEW');
});

test('a non-JSON error falls back to the generic message', async () => {
  respond(502, undefined);
  await assert.rejects(api.get('/x'), err => err.message === 'Error 502' && err.status === 502);
});

test('a successful call returns the parsed body', async () => {
  respond(200, { ok: true });
  assert.deepEqual(await api.get('/x'), { ok: true });
});

test('upload sends the raw body with the given content type and the active token', async () => {
  store.set('tessera_active', 'eva');
  store.set('tessera_accounts', JSON.stringify([{ username: 'eva', role: 'EVENT_ADMIN', token: 'tok-1' }]));
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ updated: 2 }) };
  };
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const result = await api.upload('/api/events/1/holders', bytes, 'text/csv');
  assert.deepEqual(result, { updated: 2 });
  assert.equal(seen.url, '/api/events/1/holders');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'text/csv');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-1');
  assert.equal(seen.init.body, bytes, 'the body is passed through untouched');
});
