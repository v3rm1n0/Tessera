import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../server/throttle.js';

const WINDOW = 15 * 60 * 1000;
const T0 = 1_000_000;

function failTimes(throttle, n, ip, user, now = T0) {
  for (let i = 0; i < n; i++) throttle.fail(ip, user, now);
}

test('failures block one (ip, username) pair only', () => {
  const t = createThrottle();
  failTimes(t, 7, '1.1.1.1', 'victim');
  assert.equal(t.check('1.1.1.1', 'victim', T0).blocked, false, '7 failures are still allowed');
  t.fail('1.1.1.1', 'victim', T0);
  assert.equal(t.check('1.1.1.1', 'victim', T0).blocked, true, 'the 8th failure blocks the pair');
  assert.equal(t.check('2.2.2.2', 'victim', T0).blocked, false, 'the same user from another address is fine');
  assert.equal(t.check('1.1.1.1', 'someone-else', T0).blocked, false, 'another user from that address is fine');
});

test('many addresses guessing one username trip the per-user backstop', () => {
  const t = createThrottle();
  for (let i = 0; i < 40; i++) t.fail(`10.0.0.${i}`, 'victim', T0);
  assert.equal(t.check('9.9.9.9', 'victim', T0).blocked, true);
  assert.equal(t.check('9.9.9.9', 'other', T0).blocked, false);
});

test('spraying many usernames from one address trips the per-ip backstop', () => {
  const t = createThrottle();
  for (let i = 0; i < 200; i++) t.fail('5.5.5.5', `user${i}`, T0);
  assert.equal(t.check('5.5.5.5', 'brand-new', T0).blocked, true);
  assert.equal(t.check('6.6.6.6', 'brand-new', T0).blocked, false);
});

test('a successful login clears the pair and username counters but not the address counter', () => {
  const t = createThrottle({ maxPerIp: 10 });
  failTimes(t, 7, '1.1.1.1', 'neo');
  t.succeed('1.1.1.1', 'neo');
  failTimes(t, 7, '1.1.1.1', 'neo');
  assert.equal(t.check('1.1.1.1', 'neo', T0).blocked, true, 'now blocked by the address counter (14 >= 10)');
  const fresh = createThrottle();
  failTimes(fresh, 7, '1.1.1.1', 'neo');
  fresh.succeed('1.1.1.1', 'neo');
  failTimes(fresh, 7, '1.1.1.1', 'neo');
  assert.equal(fresh.check('1.1.1.1', 'neo', T0).blocked, false, 'pair counter restarted after the success');
});

test('blocks expire after the window and report the remaining seconds', () => {
  const t = createThrottle({ windowMs: WINDOW });
  failTimes(t, 8, '1.1.1.1', 'victim', T0);
  const mid = t.check('1.1.1.1', 'victim', T0 + 5 * 60 * 1000);
  assert.deepEqual(mid, { blocked: true, retryAfter: 600 });
  assert.equal(t.check('1.1.1.1', 'victim', T0 + WINDOW).blocked, false);
  assert.equal(t.check('1.1.1.1', 'victim', T0 + WINDOW + 1).blocked, false);
});

test('usernames are compared case-insensitively and trimmed', () => {
  const t = createThrottle();
  for (let i = 0; i < 8; i++) t.fail('1.1.1.1', i % 2 ? 'Victim' : 'victim ', T0);
  assert.equal(t.check('1.1.1.1', ' VICTIM', T0).blocked, true);
});

test('huge usernames do not create huge keys or break anything', () => {
  const t = createThrottle();
  const giant = 'x'.repeat(1_000_000);
  failTimes(t, 8, '1.1.1.1', giant);
  assert.equal(t.check('1.1.1.1', giant, T0).blocked, true);
});

test('memory stays bounded however many distinct clients fail', () => {
  const t = createThrottle();
  for (let i = 0; i < 25_000; i++) t.fail(`ip-${i}`, `user-${i}`, T0);
  assert.ok(t.size() <= 10_000, `size ${t.size()} should be capped`);
});

test('expired buckets are swept so they do not accumulate', () => {
  const t = createThrottle({ windowMs: 1000 });
  for (let i = 0; i < 1500; i++) t.fail(`ip-${i}`, `user-${i}`, T0);
  t.fail('late', 'late', T0 + 5000); // triggers the sweep once the old buckets expired
  assert.ok(t.size() < 100, `size ${t.size()} should have shrunk`);
});

test('reset clears everything', () => {
  const t = createThrottle();
  failTimes(t, 8, '1.1.1.1', 'victim');
  t.reset();
  assert.equal(t.check('1.1.1.1', 'victim', T0).blocked, false);
  assert.equal(t.size(), 0);
});
