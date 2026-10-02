import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

const { SESSION_TTL_MS, purgeExpiredSessions } = await import('../server/auth.js');
const HOUR = 60 * 60 * 1000;

let app, token;

before(async () => {
  app = await startTestApp();
  token = (await app.login('owner', OWNER_PASSWORD)).token;
});

const expiry = () => app.db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token)?.expires_at;
const setExpiry = ms => app.db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(ms, token);
const me = (headers = {}) => fetch(`${app.base}/api/me`, { headers });

test('sessions last 12 hours of inactivity', () => {
  assert.equal(SESSION_TTL_MS, 12 * HOUR);
});

test('using a session with less than half its time left extends it to a full period', async () => {
  setExpiry(Date.now() + HOUR);
  const res = await me({ Authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  const left = expiry() - Date.now();
  assert.ok(left > SESSION_TTL_MS - 10_000 && left <= SESSION_TTL_MS, `left ${left} ms`);
});

test('a session with more than half its time left is not rewritten', async () => {
  const fixed = Date.now() + 11 * HOUR;
  setExpiry(fixed);
  assert.equal((await me({ Authorization: `Bearer ${token}` })).status, 200);
  assert.equal(expiry(), fixed);
});

test('an expired session is rejected and removed', async () => {
  setExpiry(Date.now() - 1000);
  const res = await me({ Authorization: `Bearer ${token}` });
  assert.equal(res.status, 401);
  assert.equal(expiry(), undefined, 'the row is deleted');
  token = (await app.login('owner', OWNER_PASSWORD)).token; // fresh session for the next tests
});

test('cookie-authenticated requests refresh the cookie, bearer-authenticated ones leave it alone', async () => {
  setExpiry(Date.now() + HOUR);
  const viaCookie = await me({ cookie: `tessera_session=${token}` });
  assert.equal(viaCookie.status, 200);
  const setCookie = viaCookie.headers.get('set-cookie');
  assert.ok(setCookie?.includes(`tessera_session=${token}`), 'same session token');
  assert.ok(setCookie.includes(`Max-Age=${SESSION_TTL_MS / 1000}`), 'full lifetime again');
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));

  setExpiry(Date.now() + HOUR);
  const viaBearer = await me({ Authorization: `Bearer ${token}` });
  assert.equal(viaBearer.status, 200);
  assert.equal(viaBearer.headers.get('set-cookie'), null, 'the account switcher must not have its cookie swapped');
});

test('purgeExpiredSessions deletes only expired sessions', () => {
  const now = Date.now();
  const insert = app.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 1, ?)');
  insert.run('expired-a', now - 5000);
  insert.run('expired-b', now - 1);
  insert.run('valid-a', now + 5000);
  assert.equal(purgeExpiredSessions(now), 2);
  const left = app.db.prepare("SELECT token FROM sessions WHERE token LIKE 'expired-%' OR token LIKE 'valid-%'").all();
  assert.deepEqual(left.map(r => r.token), ['valid-a']);
  assert.equal(purgeExpiredSessions(now), 0, 'nothing left to purge');
});
