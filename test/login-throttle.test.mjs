import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner;

before(async () => {
  // as if behind a reverse proxy on the same machine: X-Forwarded-For names the real client
  app = await startTestApp({ TRUST_PROXY: 'loopback' });
  owner = await app.login('owner', OWNER_PASSWORD);
  for (const username of ['victim-user', 'bystander', 'busy-user']) {
    await owner('POST', '/api/admin/users', { username, password: `pw-${username}-123`, role: 'SCANNER' });
  }
});

function login(username, password, ip) {
  return app.as(null)('POST', '/api/login', { username, password }, { headers: { 'X-Forwarded-For': ip } });
}

test('guessing one username from one address locks only that pair', async () => {
  for (let i = 0; i < 8; i++) {
    assert.equal((await login('victim-user', `wrong-${i}`, '203.0.113.1')).status, 401);
  }
  const blocked = await login('victim-user', 'pw-victim-user-123', '203.0.113.1');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  // the real user, from another address, is not locked out by someone else's guesses
  assert.equal((await login('victim-user', 'pw-victim-user-123', '198.51.100.7')).status, 200);
});

test('failures from one address do not lock out other addresses', async () => {
  for (let i = 0; i < 60; i++) {
    assert.equal((await login(`spray-${i}`, 'nope-nope', '203.0.113.2')).status, 401);
  }
  assert.equal((await login('bystander', 'pw-bystander-123', '203.0.113.2')).status, 200, 'below the per-address limit');
  assert.equal((await login('busy-user', 'pw-busy-user-123', '198.51.100.8')).status, 200, 'other addresses unaffected');
});
