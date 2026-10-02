import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

const { loginThrottle } = await import('../server/routes/auth.js');

let app, owner, ev, ownerId;
const userId = async name => (await owner('GET', '/api/admin/users')).data.find(u => u.username === name).id;
const rawLogin = (username, password) => app.as(null)('POST', '/api/login', { username, password });
const makeUser = (username, password) =>
  owner('POST', '/api/admin/users', { username, password, role: 'SCANNER' });

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ownerId = (await owner('GET', '/api/me')).data.id;
  ev = await app.event(owner, 'Passwords');
});

test('the owner can reset an account password; the old one stops working and its sessions end', async () => {
  await makeUser('pat', 'pat-password-1');
  const session = await app.login('pat', 'pat-password-1');
  assert.equal((await session('GET', '/api/me')).status, 200);

  const res = await owner('PATCH', `/api/admin/users/${await userId('pat')}`, { password: 'brand-new-pass' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });

  assert.equal((await session('GET', '/api/me')).status, 401, 'the old session is gone');
  const old = await rawLogin('pat', 'pat-password-1');
  assert.equal(old.status, 401);
  assert.equal(old.data.code, 'INVALID_CREDENTIALS');
  assert.equal((await rawLogin('pat', 'brand-new-pass')).status, 200);
});

test('a reset is validated and reserved for the owner', async () => {
  const id = await userId('pat');
  assert.equal((await owner('PATCH', `/api/admin/users/${id}`, { password: 'short' })).data.code, 'PASSWORD_TOO_SHORT');
  assert.equal((await owner('PATCH', `/api/admin/users/${id}`, { password: 'x'.repeat(257) })).data.code, 'PASSWORD_TOO_LONG');
  for (const password of [undefined, 12345678, null]) {
    assert.equal((await owner('PATCH', `/api/admin/users/${id}`, { password })).data.code, 'CREDENTIALS_REQUIRED');
  }
  assert.equal((await owner('PATCH', '/api/admin/users/99999', { password: 'long-enough-pw' })).data.code, 'USER_NOT_FOUND');
  assert.equal((await owner('PATCH', `/api/admin/users/${ownerId}`, { password: 'long-enough-pw' })).status, 404,
    'the owner account is changed through the personal route or the cli, not here');
  assert.equal((await ev.admin('PATCH', `/api/admin/users/${id}`, { password: 'long-enough-pw' })).status, 403);
  assert.equal((await ev.scanner('PATCH', `/api/admin/users/${id}`, { password: 'long-enough-pw' })).status, 403);
  assert.equal((await app.as(null)('PATCH', `/api/admin/users/${id}`, { password: 'long-enough-pw' })).status, 401);
});

test('anyone can change their own password; this session stays, the others end', async () => {
  await makeUser('chg', 'chg-password-1');
  const here = await app.login('chg', 'chg-password-1');
  const elsewhere = await app.login('chg', 'chg-password-1');

  const wrong = await here('POST', '/api/me/password', { current: 'not-my-password', next: 'chg-password-2' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.code, 'CURRENT_PASSWORD_WRONG');
  assert.equal((await rawLogin('chg', 'chg-password-1')).status, 200, 'the password is unchanged');

  const ok = await here('POST', '/api/me/password', { current: 'chg-password-1', next: 'chg-password-2' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok: true });
  assert.equal((await here('GET', '/api/me')).status, 200, 'the device that changed it stays signed in');
  assert.equal((await elsewhere('GET', '/api/me')).status, 401, 'other devices are signed out');
  assert.equal((await rawLogin('chg', 'chg-password-1')).status, 401);
  assert.equal((await rawLogin('chg', 'chg-password-2')).status, 200);
});

test('the owner can change their own password the same way', async () => {
  const session = await app.login('owner', OWNER_PASSWORD);
  assert.equal((await session('POST', '/api/me/password', { current: OWNER_PASSWORD, next: 'new-owner-password' })).status, 200);
  assert.equal((await rawLogin('owner', OWNER_PASSWORD)).status, 401);
  assert.equal((await rawLogin('owner', 'new-owner-password')).status, 200);
  assert.equal((await session('POST', '/api/me/password', { current: 'new-owner-password', next: OWNER_PASSWORD })).status, 200);
  owner = await app.login('owner', OWNER_PASSWORD);
});

test('the new password must be different and valid; the current one is required', async () => {
  await makeUser('val', 'val-password-1');
  const me = await app.login('val', 'val-password-1');
  const same = await me('POST', '/api/me/password', { current: 'val-password-1', next: 'val-password-1' });
  assert.equal(same.status, 400);
  assert.equal(same.data.code, 'PASSWORD_UNCHANGED');
  assert.equal((await me('POST', '/api/me/password', { current: 'val-password-1', next: 'short' })).data.code, 'PASSWORD_TOO_SHORT');
  assert.equal((await me('POST', '/api/me/password', { current: 'val-password-1', next: 12345678 })).data.code, 'CREDENTIALS_REQUIRED');
  assert.equal((await me('POST', '/api/me/password', { next: 'another-password' })).data.code, 'CREDENTIALS_REQUIRED');
  assert.equal((await app.as(null)('POST', '/api/me/password', { current: 'x', next: 'another-password' })).status, 401);
});

test('wrong current passwords are throttled like failed logins', async () => {
  loginThrottle.reset();
  await makeUser('brute', 'brute-password-1');
  const me = await app.login('brute', 'brute-password-1');
  for (let i = 0; i < 8; i++) {
    assert.equal((await me('POST', '/api/me/password', { current: `guess-${i}-guess`, next: 'whatever-password' })).status, 403);
  }
  const blocked = await me('POST', '/api/me/password', { current: 'brute-password-1', next: 'whatever-password' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  loginThrottle.reset();
});

test('password changes are audited without ever logging a password', async () => {
  const entries = (await owner('GET', '/api/admin/audit?limit=200')).data.items;
  assert.ok(entries.some(e => e.action === 'user.password_reset' && e.target === 'pat' && e.username === 'owner'));
  assert.ok(entries.some(e => e.action === 'password.change' && e.target === 'chg' && e.username === 'chg'));
  const text = JSON.stringify(entries);
  for (const secret of ['brand-new-pass', 'chg-password-2', 'new-owner-password']) {
    assert.ok(!text.includes(secret), `${secret} must not appear in the log`);
  }
});
