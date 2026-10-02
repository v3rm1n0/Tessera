import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

const BACKDROP_BYTES = 200_000;
let app, owner, ev;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Payload');
  const up = await ev.admin('POST', `/api/events/${ev.id}/card/backdrop`, undefined, {
    raw: Buffer.alloc(BACKDROP_BYTES, 7), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(up.status, 201);
});

const size = res => JSON.stringify(res.data).length;

test('the owner event list does not serialize the card backdrop', async () => {
  const res = await owner('GET', '/api/admin/events');
  assert.equal(res.status, 200);
  assert.ok(size(res) < 4000, `response is ${size(res)} bytes`);
  assert.ok(res.data.every(row => !('card_backdrop' in row)));
  assert.ok(res.data.every(row => 'card_backdrop_mime' in row), 'other columns are still there');
});

test('saving the reset time does not echo the card backdrop', async () => {
  const res = await ev.admin('PATCH', `/api/events/${ev.id}`, { reset_time: '03:00' });
  assert.equal(res.status, 200);
  assert.equal(res.data.reset_time, '03:00');
  assert.ok(size(res) < 4000, `response is ${size(res)} bytes`);
  assert.ok(!('card_backdrop' in res.data));
});

test('the backdrop itself is still stored and downloadable', async () => {
  const img = await ev.admin('GET', `/api/events/${ev.id}/card/backdrop`);
  assert.equal(img.status, 200);
  assert.equal(img.data.length, BACKDROP_BYTES);
  assert.equal((await ev.admin('GET', `/api/events/${ev.id}/card`)).data.has_backdrop, true);
});
