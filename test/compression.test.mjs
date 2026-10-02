import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Compression');
  const section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Gate' })).data;
  await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 400 }); // a response of tens of kilobytes
});

/** A GET that keeps the body exactly as sent (fetch would decompress it for us). */
function rawGet(pathname, { headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, app.base);
    http.get(url, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const GZIP = { 'Accept-Encoding': 'gzip' };

test('scripts are compressed for clients that accept it, and the bytes decompress to the same file', async () => {
  const plain = await rawGet('/js/app.js');
  const packed = await rawGet('/js/app.js', { headers: GZIP });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.match(packed.headers.vary, /Accept-Encoding/i);
  assert.ok(packed.body.length < plain.body.length / 2, 'noticeably smaller');
  assert.ok(zlib.gunzipSync(packed.body).equals(plain.body));
  assert.equal(plain.headers['content-encoding'], undefined, 'no compression unless asked for');
});

test('large API answers are compressed, small ones are left alone', async () => {
  const big = await rawGet(`/api/events/${ev.id}/card/tickets`, { headers: GZIP, token: ev.admin.token });
  assert.equal(big.status, 200);
  assert.equal(big.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(big.body)).length, 400);

  const small = await rawGet('/api/me', { headers: GZIP, token: ev.admin.token });
  assert.equal(small.status, 200);
  assert.equal(small.headers['content-encoding'], undefined, 'not worth the CPU below the size threshold');
});

test('files that are compressed already are not compressed again', async () => {
  const sheet = await rawGet(`/api/events/${ev.id}/tickets.xlsx`, { headers: GZIP, token: ev.admin.token });
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers['content-encoding'], undefined);
  const font = await rawGet('/fonts/figtree-latin-400-normal.woff2', { headers: GZIP });
  assert.equal(font.headers['content-encoding'], undefined);
  const icon = await rawGet('/icons/icon-512.png', { headers: GZIP });
  assert.equal(icon.headers['content-encoding'], undefined);
});

test('fonts are cached for a week and vendored scripts for a day; app files are still revalidated', async () => {
  assert.equal((await rawGet('/fonts/figtree-latin-400-normal.woff2')).headers['cache-control'], 'public, max-age=604800');
  assert.equal((await rawGet('/vendor/jsQR.js')).headers['cache-control'], 'public, max-age=86400');
  assert.equal((await rawGet('/js/app.js')).headers['cache-control'], 'public, max-age=0');
  assert.equal((await rawGet('/css/app.css')).headers['cache-control'], 'public, max-age=0');
  assert.equal((await rawGet('/sw.js')).headers['cache-control'], 'no-cache', 'the worker is always revalidated');
});

test('a conditional request for a cached file still gets its 304', async () => {
  const first = await rawGet('/vendor/jsQR.js', { headers: GZIP });
  const again = await rawGet('/vendor/jsQR.js', { headers: { ...GZIP, 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
});
