import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVendor } from '../public/js/vendor.js';

class FakeScript {
  #listeners = {};
  removed = false;
  addEventListener(type, fn) { this.#listeners[type] = fn; }
  fire(type) { this.#listeners[type]?.(); }
  remove() { this.removed = true; }
}

/** A document that only knows what the loader needs: createElement('script') and head.append. */
function fakeDocument() {
  const injected = [];
  return {
    injected,
    createElement(tag) { assert.equal(tag, 'script'); return new FakeScript(); },
    head: { append(script) { injected.push(script); } },
  };
}

const settled = async promise => Promise.race([promise.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setImmediate(() => resolve('pending')))]);

test('each vendor script is injected from its own file, and the promise waits for the load', async () => {
  const doc = fakeDocument();
  const promise = loadVendor('jsqr', doc);
  assert.equal(doc.injected.length, 1);
  assert.equal(doc.injected[0].src, '/vendor/jsQR.js');
  assert.equal(await settled(promise), 'pending');
  doc.injected[0].fire('load');
  assert.equal(await settled(promise), 'resolved');

  loadVendor('jszip', doc);
  loadVendor('qrcode', doc);
  assert.deepEqual(doc.injected.map(script => script.src), ['/vendor/jsQR.js', '/vendor/jszip.js', '/vendor/qrcode-generator.js']);
});

test('asking again, while loading or afterwards, shares the one promise and injects nothing more', async () => {
  const doc = fakeDocument();
  const first = loadVendor('jszip', doc);
  assert.equal(loadVendor('jszip', doc), first);
  doc.injected[0].fire('load');
  await first;
  assert.equal(loadVendor('jszip', doc), first);
  assert.equal(doc.injected.length, 1);
});

test('a failed load rejects, removes the script and can be retried', async () => {
  const doc = fakeDocument();
  const failing = loadVendor('qrcode', doc);
  doc.injected[0].fire('error');
  await assert.rejects(failing, /qrcode-generator\.js/);
  assert.equal(doc.injected[0].removed, true);

  const retry = loadVendor('qrcode', doc);
  assert.notEqual(retry, failing);
  assert.equal(doc.injected.length, 2, 'a second script was injected');
  doc.injected[1].fire('load');
  await retry;
  assert.equal(loadVendor('qrcode', doc), retry, 'and now it is remembered');
});

test('an unknown name is a programming error and throws at once', () => {
  assert.throws(() => loadVendor('lodash', fakeDocument()), /lodash/);
  assert.throws(() => loadVendor(undefined, fakeDocument()));
});

test('every document keeps its own record', () => {
  const [one, two] = [fakeDocument(), fakeDocument()];
  loadVendor('jsqr', one);
  loadVendor('jsqr', two);
  assert.equal(one.injected.length, 1);
  assert.equal(two.injected.length, 1);
});
