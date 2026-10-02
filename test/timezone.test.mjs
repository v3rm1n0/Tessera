import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { resetBoundary, serverTimeZone } from '../server/time.js';

// a zone whose midnight is far from the server's, so mixing the two up cannot go unnoticed
const ZONE = serverTimeZone() === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';

let app, owner, ev, section, codes;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Zones');
  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Gate' })).data;
  codes = (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 6 })).data.uuids;
});

test('new events start in the server time zone', async () => {
  const created = await owner('POST', '/api/admin/events', { name: 'Fresh' });
  assert.equal(created.data.timezone, serverTimeZone());
  const list = (await owner('GET', '/api/admin/events')).data;
  assert.ok(list.length >= 2 && list.every(e => e.timezone), 'every event has an explicit zone');
  const me = (await ev.admin('GET', '/api/me')).data;
  assert.equal(me.events[0].timezone, serverTimeZone());
});

test('settings accept a time zone, a reset time, or both', async () => {
  const path = `/api/events/${ev.id}`;
  const none = await ev.admin('PATCH', path, {});
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'SETTINGS_REQUIRED');

  for (const timezone of ['Mars/Base', 42, '', null]) {
    const res = await ev.admin('PATCH', path, { timezone });
    assert.equal(res.status, 400, JSON.stringify(timezone));
    assert.equal(res.data.code, 'TIMEZONE_INVALID');
  }
  assert.equal((await ev.admin('PATCH', path, { reset_time: '7:00' })).data.code, 'RESET_TIME_INVALID');
  assert.equal((await ev.admin('PATCH', path, { reset_time: 700 })).data.code, 'RESET_TIME_INVALID');

  const zoneOnly = await ev.admin('PATCH', path, { timezone: 'pacific/kiritimati' });
  assert.equal(zoneOnly.status, 200);
  assert.equal(zoneOnly.data.timezone, 'Pacific/Kiritimati', 'stored in canonical form');
  assert.equal(zoneOnly.data.reset_time, '00:00', 'the reset time is left alone');

  const both = await ev.admin('PATCH', path, { reset_time: '05:15', timezone: 'Europe/Berlin' });
  assert.deepEqual([both.data.reset_time, both.data.timezone], ['05:15', 'Europe/Berlin']);

  const resetOnly = await ev.admin('PATCH', path, { reset_time: '06:45' });
  assert.deepEqual([resetOnly.data.reset_time, resetOnly.data.timezone], ['06:45', 'Europe/Berlin'], 'the zone is left alone');

  assert.equal((await ev.scanner('PATCH', path, { timezone: 'UTC' })).status, 403);
  const me = (await ev.admin('GET', '/api/me')).data;
  assert.deepEqual([me.events[0].reset_time, me.events[0].timezone], ['06:45', 'Europe/Berlin']);
});

test('the dashboard and scanning use the event zone to decide what "today" is', async () => {
  await ev.admin('PATCH', `/api/events/${ev.id}`, { timezone: ZONE, reset_time: '00:00' });
  const boundary = resetBoundary('00:00', undefined, ZONE);
  assert.notEqual(boundary, resetBoundary('00:00'), 'the zone really changes the boundary');

  const dash = await ev.scanner('GET', `/api/events/${ev.id}/dashboard`);
  assert.equal(dash.data.reset_boundary, boundary);
  assert.equal(dash.data.event.timezone, ZONE);
  assert.equal(dash.data.event.reset_time, '00:00');

  const insert = app.db.prepare(
    "INSERT INTO scans (ticket_uuid, section_id, result, scan_number, scanned_at) VALUES (?, ?, 'OK', 1, ?)");
  insert.run(codes[0], section.id, boundary - 1000); // yesterday for this event
  insert.run(codes[1], section.id, boundary + 1000); // today for this event

  const after = await ev.scanner('GET', `/api/events/${ev.id}/dashboard`);
  assert.equal(after.data.total_scans_today, 1, 'only the scan after the event-local midnight counts');

  const first = await ev.scanner('POST', '/api/scan', { code: codes[0] });
  assert.equal(first.data.status, 'OK', 'a scan from before the boundary does not make a duplicate');
  const again = await ev.scanner('POST', '/api/scan', { code: codes[1] });
  assert.equal(again.data.status, 'DOUBLE', 'a scan from after the boundary does');
  assert.equal(again.data.first_scanned_at, boundary + 1000);

  const doubles = await ev.scanner('GET', `/api/sections/${section.id}/doubles`);
  assert.equal(doubles.data.doubles.length, 1);
});
