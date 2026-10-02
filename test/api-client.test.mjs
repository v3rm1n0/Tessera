import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// the client modules read localStorage lazily; give them an in-memory one
const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
const { api, setUnauthorizedHandler } = await import('../public/js/api.js');
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

beforeEach(() => { store.clear(); setLang('en'); setUnauthorizedHandler(null); });

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

/** A fetch whose promise settles only when the request is aborted (a dead connection). */
function hangingFetch() {
  return (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
}

test('a stalled request is aborted after the timeout and reported as a network error', async () => {
  globalThis.fetch = hangingFetch();
  const started = Date.now();
  await assert.rejects(api.get('/x', { timeoutMs: 30 }), err => {
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.status, 0);
    assert.equal(err.message, 'No connection to the server.');
    return true;
  });
  assert.ok(Date.now() - started < 1000, 'it did not wait for the default timeout');
  setLang('de');
  await assert.rejects(api.post('/x', {}, { timeoutMs: 20 }), err => err.message === 'Keine Verbindung zum Server.');
});

test('a failing connection is a network error too', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.get('/x'), err => err.code === 'NETWORK' && err.status === 0 && err.message === 'No connection to the server.');
});

test('a response body that never finishes arriving is a network error', async () => {
  globalThis.fetch = (url, init) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(api.get('/x', { timeoutMs: 30 }), err => err.code === 'NETWORK');
});

test('requests get a default timeout and no timer is left behind', async () => {
  const live = new Set();
  const delays = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { const id = realSet(fn, ms, ...rest); live.add(id); delays.push(ms); return id; };
  globalThis.clearTimeout = id => { live.delete(id); realClear(id); };
  try {
    respond(200, { ok: true });
    await api.get('/x');
    respond(500, { error: 'boom', code: 'INTERNAL' });
    await assert.rejects(api.get('/x'));
    assert.deepEqual(delays, [15_000, 15_000], 'the default is 15 seconds');
    assert.equal(live.size, 0, 'timers are cleared after success and after errors');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('a 401 calls the unauthorized handler once; login-style calls can opt out', async () => {
  let calls = 0;
  setUnauthorizedHandler(() => { calls++; });
  respond(401, { error: 'Not signed in', code: 'NOT_SIGNED_IN' });
  await assert.rejects(api.get('/x'), err => err.status === 401 && err.message === 'Not signed in.');
  assert.equal(calls, 1);

  await assert.rejects(api.post('/api/login', {}, { skipAuthHandler: true }));
  assert.equal(calls, 1, 'opted out');

  respond(403, { error: 'no', code: 'NOT_AUTHORIZED' });
  await assert.rejects(api.get('/x'));
  respond(500, undefined);
  await assert.rejects(api.get('/x'));
  assert.equal(calls, 1, 'only 401 counts');
});

test('a handler that throws does not hide the original error', async () => {
  setUnauthorizedHandler(() => { throw new Error('handler bug'); });
  respond(401, { error: 'Not signed in', code: 'NOT_SIGNED_IN' });
  await assert.rejects(api.get('/x'), err => err.status === 401);
});

test('upload accepts the same options', async () => {
  globalThis.fetch = hangingFetch();
  await assert.rejects(api.upload('/x', new ArrayBuffer(1), 'text/csv', { timeoutMs: 20 }), err => err.code === 'NETWORK');
});
