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
