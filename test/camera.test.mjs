import { test } from 'node:test';
import assert from 'node:assert/strict';
import { torchSupported, setTorch, createWakeLock, watchCamera } from '../public/js/camera.js';

/** An EventTarget that counts its listeners, so tests can see everything added is removed again. */
class Target extends EventTarget {
  #listeners = new Map();
  addEventListener(type, fn, ...rest) {
    this.#listeners.set(type, (this.#listeners.get(type) ?? new Set()).add(fn));
    super.addEventListener(type, fn, ...rest);
  }
  removeEventListener(type, fn, ...rest) {
    this.#listeners.get(type)?.delete(fn);
    super.removeEventListener(type, fn, ...rest);
  }
  count(type) { return this.#listeners.get(type)?.size ?? 0; }
}

class FakeTrack extends Target {
  readyState = 'live';
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

class FakeDoc extends Target {
  visibilityState = 'visible';
  show() { this.visibilityState = 'visible'; this.dispatchEvent(new Event('visibilitychange')); }
  hide() { this.visibilityState = 'hidden'; this.dispatchEvent(new Event('visibilitychange')); }
}

const streamOf = (...tracks) => ({ getTracks: () => tracks });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeNav({ failWith } = {}) {
  const nav = { requests: 0, sentinels: [] };
  nav.wakeLock = {
    request: async type => {
      assert.equal(type, 'screen');
      nav.requests++;
      if (failWith) throw failWith;
      const sentinel = { released: false, release: async () => { sentinel.released = true; } };
      nav.sentinels.push(sentinel);
      return sentinel;
    },
  };
  return nav;
}

// ---------------------------------------------------------------- torch

test('the torch is offered only when the track says it can switch it', () => {
  assert.equal(torchSupported({ getCapabilities: () => ({ torch: true }) }), true);
  assert.equal(torchSupported({ getCapabilities: () => ({ torch: false }) }), false);
  assert.equal(torchSupported({ getCapabilities: () => ({}) }), false);
  assert.equal(torchSupported({}), false, 'browsers without getCapabilities');
  assert.equal(torchSupported({ getCapabilities: () => { throw new Error('unsupported'); } }), false);
  assert.equal(torchSupported(undefined), false);
});

test('setTorch applies the advanced torch constraint and reports success', async () => {
  const calls = [];
  const track = { applyConstraints: async constraints => { calls.push(constraints); } };
  assert.equal(await setTorch(track, true), true);
  assert.equal(await setTorch(track, false), true);
  assert.deepEqual(calls, [{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }]);
});

test('setTorch reports failure instead of throwing', async () => {
  assert.equal(await setTorch({ applyConstraints: async () => { throw new Error('OverconstrainedError'); } }, true), false);
  assert.equal(await setTorch({}, true), false);
  assert.equal(await setTorch(null, true), false);
});

// ---------------------------------------------------------------- wake lock

test('without the Wake Lock API everything is a harmless no-op', async () => {
  const doc = new FakeDoc();
  const lock = createWakeLock({}, doc);
  await lock.acquire();
  await lock.release();
  assert.equal(doc.count('visibilitychange'), 0);
});

test('acquire asks for a screen lock once, even when called twice', async () => {
  const nav = fakeNav();
  const lock = createWakeLock(nav, new FakeDoc());
  await lock.acquire();
  await lock.acquire();
  assert.equal(nav.requests, 1);
});

test('the lock is requested again when the page returns to the foreground', async () => {
  const nav = fakeNav();
  const doc = new FakeDoc();
  const lock = createWakeLock(nav, doc);
  await lock.acquire();
  nav.sentinels[0].released = true; // the browser drops the lock as soon as the page is hidden
  doc.hide();
  await tick();
  assert.equal(nav.requests, 1, 'nothing is requested while hidden');
  doc.show();
  await tick();
  assert.equal(nav.requests, 2);
});

test('a lock that is still held is not requested again', async () => {
  const nav = fakeNav();
  const doc = new FakeDoc();
  const lock = createWakeLock(nav, doc);
  await lock.acquire();
  doc.hide();
  doc.show();
  await tick();
  assert.equal(nav.requests, 1);
});

test('release gives the lock back and stops listening', async () => {
  const nav = fakeNav();
  const doc = new FakeDoc();
  const lock = createWakeLock(nav, doc);
  await lock.acquire();
  await lock.release();
  assert.equal(nav.sentinels[0].released, true);
  assert.equal(doc.count('visibilitychange'), 0);
  doc.hide();
  doc.show();
  await tick();
  assert.equal(nav.requests, 1);
  await lock.release(); // twice is fine
});

test('releasing while the request is still pending does not leak the lock', async () => {
  const doc = new FakeDoc();
  const sentinel = { released: false, release: async () => { sentinel.released = true; } };
  let grant;
  const nav = { wakeLock: { request: () => new Promise(resolve => { grant = () => resolve(sentinel); }) } };
  const lock = createWakeLock(nav, doc);
  const acquiring = lock.acquire();
  await lock.release();
  grant();
  await acquiring;
  assert.equal(sentinel.released, true);
});

test('a refused request does not throw and is tried again when the page is shown', async () => {
  const nav = fakeNav({ failWith: Object.assign(new Error('battery saver'), { name: 'NotAllowedError' }) });
  const doc = new FakeDoc();
  const lock = createWakeLock(nav, doc);
  await lock.acquire();
  assert.equal(nav.requests, 1);
  doc.hide();
  doc.show();
  await tick();
  assert.equal(nav.requests, 2);
});

// ---------------------------------------------------------------- lost camera

test('a track that ends reports the lost camera once and stops listening', () => {
  const track = new FakeTrack();
  const doc = new FakeDoc();
  let lost = 0;
  watchCamera(streamOf(track), doc, () => { lost++; });
  track.end();
  assert.equal(lost, 1);
  track.dispatchEvent(new Event('ended'));
  doc.show();
  assert.equal(lost, 1);
  assert.equal(track.count('ended'), 0);
  assert.equal(doc.count('visibilitychange'), 0);
});

test('every track of the stream is watched', () => {
  const [video, other] = [new FakeTrack(), new FakeTrack()];
  let lost = 0;
  watchCamera(streamOf(video, other), new FakeDoc(), () => { lost++; });
  other.end();
  assert.equal(lost, 1);
});

test('coming back to the foreground with a dead track reports it (nobody told us while hidden)', () => {
  const track = new FakeTrack();
  const doc = new FakeDoc();
  let lost = 0;
  watchCamera(streamOf(track), doc, () => { lost++; });
  track.readyState = 'ended'; // the browser stopped the camera of the hidden page without an event
  doc.hide();
  assert.equal(lost, 0);
  doc.show();
  assert.equal(lost, 1);
});

test('coming back to the foreground with a live camera reports nothing', () => {
  const track = new FakeTrack();
  const doc = new FakeDoc();
  let lost = 0;
  watchCamera(streamOf(track), doc, () => { lost++; });
  doc.hide();
  doc.show();
  assert.equal(lost, 0);
});

test('unsubscribing removes every listener and silences the watcher', () => {
  const track = new FakeTrack();
  const doc = new FakeDoc();
  let lost = 0;
  const stop = watchCamera(streamOf(track), doc, () => { lost++; });
  stop();
  assert.equal(track.count('ended'), 0);
  assert.equal(doc.count('visibilitychange'), 0);
  track.end();
  assert.equal(lost, 0);
});
