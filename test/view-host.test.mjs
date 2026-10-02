import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createViewHost } from '../public/js/view-host.js';

const counter = () => { const fn = () => { fn.calls++; }; fn.calls = 0; return fn; };

test('begin hands out increasing ids and only the latest is current', () => {
  const host = createViewHost();
  const first = host.begin();
  assert.equal(host.isCurrent(first), true);
  const second = host.begin();
  assert.ok(second > first);
  assert.equal(host.isCurrent(first), false);
  assert.equal(host.isCurrent(second), true);
});

test('the cleanup of a finished view runs exactly once, when the next one begins', () => {
  const host = createViewHost();
  const cleanup = counter();
  const id = host.begin();
  assert.equal(host.finish(id, cleanup), true);
  assert.equal(cleanup.calls, 0, 'the view is still on screen');
  host.begin();
  assert.equal(cleanup.calls, 1);
  host.begin();
  assert.equal(cleanup.calls, 1, 'it is not run again');
});

test('a view that finishes after another began is torn down at once and never becomes current', () => {
  const host = createViewHost();
  const slow = counter();
  const fast = counter();
  const first = host.begin();   // e.g. the scanner waiting for the camera
  const second = host.begin();  // the user went to the dashboard meanwhile
  assert.equal(host.finish(second, fast), true);
  assert.equal(host.finish(first, slow), false);
  assert.equal(slow.calls, 1, 'the late view is stopped immediately (camera off)');
  assert.equal(fast.calls, 0, 'the current view is untouched');
  host.begin();
  assert.equal(fast.calls, 1);
  assert.equal(slow.calls, 1);
});

test('a stale view that finishes before the newer one does not disturb it either', () => {
  const host = createViewHost();
  const stale = counter();
  const current = counter();
  const first = host.begin();
  const second = host.begin();
  assert.equal(host.finish(first, stale), false);
  assert.equal(stale.calls, 1);
  assert.equal(host.finish(second, current), true);
  assert.equal(current.calls, 0);
});

test('views without a cleanup are fine', () => {
  const host = createViewHost();
  assert.equal(host.finish(host.begin()), true);
  assert.doesNotThrow(() => host.begin());
  const stale = host.begin();
  host.begin();
  assert.equal(host.finish(stale, undefined), false);
});

test('a cleanup that throws does not break navigation', () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const host = createViewHost();
    host.finish(host.begin(), () => { throw new Error('camera already gone'); });
    let id;
    assert.doesNotThrow(() => { id = host.begin(); });
    assert.equal(host.isCurrent(id), true);
    const stale = host.begin();
    host.begin();
    assert.equal(host.finish(stale, () => { throw new Error('boom'); }), false);
    assert.equal(log.mock.callCount(), 2);
  } finally {
    log.mock.restore();
  }
});
