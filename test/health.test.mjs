import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp } from './helpers.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let app;
before(async () => { app = await startTestApp(); });

/** The app with its own health check, listening on a port of its own. */
async function appWithCheck(healthCheck) {
  const { createApp } = await import('../server/index.js');
  const server = await new Promise(resolve => { const s = createApp({ healthCheck }).listen(0, () => resolve(s)); });
  server.unref();
  return `http://localhost:${server.address().port}`;
}

test('the health endpoint answers without any login, with version and uptime, and is never cached', async () => {
  const res = await fetch(`${app.base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['status', 'uptime', 'version'], 'nothing else is revealed');
  assert.equal(body.status, 'ok');
  assert.equal(body.version, version);
  assert.ok(Number.isInteger(body.uptime) && body.uptime >= 0);
});

test('a bad or expired token does not matter: the probe never depends on sessions', async () => {
  const res = await fetch(`${app.base}/healthz`, { headers: { Authorization: 'Bearer not-a-real-token', cookie: 'tessera_session=garbage' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('when the database check throws, the answer is 503 with nothing but the status', async () => {
  const base = await appWithCheck(() => { throw new Error('disk I/O error at /secret/path'); });
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { status: 'error' });
});

// last in the file: it closes the database this process shares
test('the default check queries the database, so a database that no longer answers fails the probe', async () => {
  const { db } = await import('../server/db.js');
  db.close();
  const res = await fetch(`${app.base}/healthz`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: 'error' });
});
