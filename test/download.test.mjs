import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};
const { filenameFromDisposition, saveBlob, downloadFile, REVOKE_DELAY_MS } = await import('../public/js/download.js');
const { setLang } = await import('../public/js/i18n.js');

beforeEach(() => {
  store.clear();
  store.set('tessera_active', 'eva');
  store.set('tessera_accounts', JSON.stringify([{ username: 'eva', role: 'EVENT_ADMIN', token: 'tok-9' }]));
  setLang('en');
});

test('filenameFromDisposition reads quoted and bare file names', () => {
  assert.equal(filenameFromDisposition('attachment; filename="scans-event-1.xlsx"'), 'scans-event-1.xlsx');
  assert.equal(filenameFromDisposition('attachment; filename=report.csv'), 'report.csv');
  assert.equal(filenameFromDisposition('attachment'), null);
  assert.equal(filenameFromDisposition(null), null);
});

function fakeEnvironment() {
  const log = { clicks: 0, removed: 0, appended: 0, revoked: [], timers: [] };
  const anchor = { click() { log.clicks++; }, remove() { log.removed++; } };
  return {
    log, anchor,
    deps: {
      doc: { createElement: () => anchor, body: { append: () => { log.appended++; } } },
      urls: { createObjectURL: () => 'blob:fake-1', revokeObjectURL: url => log.revoked.push(url) },
      schedule: (fn, ms) => log.timers.push({ fn, ms }),
    },
  };
}

test('saveBlob clicks a temporary link and revokes the object url only after a delay', () => {
  const { log, anchor, deps } = fakeEnvironment();
  saveBlob(new Blob(['x']), 'a.xlsx', deps);
  assert.equal(anchor.download, 'a.xlsx');
  assert.equal(anchor.href, 'blob:fake-1');
  assert.deepEqual([log.appended, log.clicks, log.removed], [1, 1, 1]);
  assert.deepEqual(log.revoked, [], 'not revoked right after the click: some browsers have not started the save yet');
  assert.equal(log.timers.length, 1);
  assert.ok(log.timers[0].ms >= 10_000 && log.timers[0].ms === REVOKE_DELAY_MS);
  log.timers[0].fn();
  assert.deepEqual(log.revoked, ['blob:fake-1']);
});

test('downloadFile sends the token in a header and saves under the server-provided name', async () => {
  const saved = [];
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, blob: async () => new Blob(['data']), headers: { get: () => 'attachment; filename="from-server.xlsx"' } };
  };
  await downloadFile('/api/events/1/scans.xlsx?lang=en', 'fallback.xlsx', { save: (blob, name) => saved.push(name) });
  assert.equal(seen.url, '/api/events/1/scans.xlsx?lang=en', 'the token is never part of the url');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-9');
  assert.deepEqual(saved, ['from-server.xlsx']);
});

test('downloadFile falls back to the given name and reports server errors in the current language', async () => {
  const saved = [];
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => new Blob(['d']), headers: { get: () => null } });
  await downloadFile('/x', 'fallback.xlsx', { save: (blob, name) => saved.push(name) });
  assert.deepEqual(saved, ['fallback.xlsx']);

  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Not authorized', code: 'NOT_AUTHORIZED' }) });
  await assert.rejects(downloadFile('/x', 'f.xlsx', { save: () => assert.fail('must not save') }), err => err.message === 'Not authorized.' && err.status === 403);

  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('html'); } });
  await assert.rejects(downloadFile('/x', 'f.xlsx', { save: () => {} }), err => err.message === 'Error 502');
});
