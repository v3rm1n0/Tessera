import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { readCookie } from '../server/auth.js';

test('readCookie returns the requested cookie', () => {
  assert.equal(readCookie('a=1; tessera_session=abc; b=2', 'tessera_session'), 'abc');
  assert.equal(readCookie('tessera_session=a=b', 'tessera_session'), 'a=b', 'value may contain =');
  assert.equal(readCookie('tessera_session=a%20b', 'tessera_session'), 'a b', 'value is decoded');
});

test('readCookie ignores malformed percent-encoding instead of throwing', () => {
  assert.equal(readCookie('a=1; tessera_session=abc; b=%E0%A4%A', 'tessera_session'), 'abc');
  assert.equal(readCookie('tessera_session=%E0%A4%A', 'tessera_session'), undefined);
});

test('readCookie copes with missing headers and cookies', () => {
  assert.equal(readCookie(undefined, 'tessera_session'), undefined);
  assert.equal(readCookie('', 'tessera_session'), undefined);
  assert.equal(readCookie('other=1', 'tessera_session'), undefined);
});

let app;
before(async () => { app = await startTestApp(); });

test('a malformed foreign cookie does not break page loads', async () => {
  for (const path of ['/', '/js/app.js']) {
    const res = await fetch(app.base + path, { headers: { cookie: 'other_app=100%' } });
    assert.equal(res.status, 200, path);
  }
});

test('api requests tolerate a malformed cookie next to a valid session cookie', async () => {
  const login = await fetch(app.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: OWNER_PASSWORD }),
  });
  const session = login.headers.get('set-cookie').split(';')[0];

  const ok = await fetch(app.base + '/api/me', { headers: { cookie: `${session}; other=%E0%A4%A` } });
  assert.equal(ok.status, 200);

  const anon = await fetch(app.base + '/api/me', { headers: { cookie: 'tessera_session=%E0%A4%A' } });
  assert.equal(anon.status, 401, 'an undecodable session cookie is simply not signed in');
});
