import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Routing');
});

test('missing static assets are a 404, not the app shell', async () => {
  for (const path of ['/js/nope.js', '/css/nope.css', '/vendor/jsQR.js.map', '/fonts/nope.woff2']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 404, path);
    assert.ok(!(res.headers.get('content-type') || '').includes('text/html'), `${path} must not return html`);
  }
});

test('extensionless client-side routes still get the app shell', async () => {
  for (const path of ['/', '/dashboard', '/some/client/route', '/verwaltung']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    assert.ok((res.headers.get('content-type') || '').includes('text/html'), path);
  }
});

test('unknown api paths are a JSON 404 for everyone', async () => {
  for (const [label, call] of [['anonymous', app.as(null)], ['owner', owner], ['scanner', ev.scanner]]) {
    for (const path of ['/api/nope', '/api', '/api/events/1/nope']) {
      const res = await call('GET', path);
      assert.equal(res.status, 404, `${label} ${path}`);
      assert.equal(res.data.code, 'NOT_FOUND', `${label} ${path}`);
    }
  }
});

test('event-role routes still enforce their roles', async () => {
  assert.equal((await owner('GET', `/api/events/${ev.id}/dashboard`)).status, 403);
  assert.equal((await app.as(null)('GET', `/api/events/${ev.id}/dashboard`)).status, 401);
  assert.equal((await owner('GET', '/api/sections/1/doubles')).status, 403);
  assert.equal((await ev.scanner('GET', `/api/events/${ev.id}/dashboard`)).status, 200);
});
