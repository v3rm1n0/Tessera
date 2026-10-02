import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev, other, section, subsection, codes, scanId, otherCode;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Archivable');
  other = await app.event(owner, 'Stays open');
  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Gate' })).data;
  subsection = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'North' })).data;
  codes = (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 6 })).data.uuids;
  scanId = (await ev.scanner('POST', '/api/scan', { code: codes[0] })).data.scan_id;
  const otherSection = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Gamma' })).data;
  otherCode = (await other.admin('POST', `/api/sections/${otherSection.id}/tickets`, { count: 1 })).data.uuids[0];
});

const eventPath = `/api/admin/events`;
const patch = body => owner('PATCH', `${eventPath}/${ev.id}`, body);
const me = async () => (await ev.admin('GET', '/api/me')).data.events[0];

test('events carry optional start and end dates', async () => {
  const first = await me();
  assert.deepEqual([first.start_date, first.end_date, first.archived], ['', '', false]);
  assert.deepEqual(Object.keys(first).sort(), ['archived', 'end_date', 'id', 'name', 'reset_time', 'start_date', 'timezone']);

  const res = await patch({ start_date: '2026-07-21', end_date: '2026-07-23' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.start_date, res.data.end_date], ['2026-07-21', '2026-07-23']);
  assert.deepEqual([(await me()).start_date, (await me()).end_date], ['2026-07-21', '2026-07-23']);

  const audit = (await owner('GET', '/api/admin/audit?limit=100')).data.items.find(e => e.action === 'event.dates');
  assert.deepEqual(audit.details, { start_date: '2026-07-21', end_date: '2026-07-23' });

  const cleared = await patch({ end_date: '' });
  assert.deepEqual([cleared.data.start_date, cleared.data.end_date], ['2026-07-21', ''], 'an empty value clears one date, the other stays');
  await patch({ start_date: '' });
});

test('dates must be real dates in order', async () => {
  for (const body of [
    { start_date: '21.07.2026' }, { start_date: '2026-02-30' }, { end_date: '2026-13-01' },
    { start_date: 20260721 }, { start_date: '2026-07-21', end_date: '2026-07-20' },
  ]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.data.code, 'DATE_INVALID');
  }
  await patch({ start_date: '2026-07-21' });
  assert.equal((await patch({ end_date: '2026-07-01' })).data.code, 'DATE_INVALID', 'checked against the stored start date');
  await patch({ start_date: '' });
  assert.equal((await patch({})).data.code, 'NOTHING_TO_UPDATE');
});

test('only the owner can archive, and archiving is reversible', async () => {
  assert.equal((await ev.admin('PATCH', `${eventPath}/${ev.id}`, { archived: true })).status, 403);
  assert.equal((await ev.scanner('PATCH', `${eventPath}/${ev.id}`, { archived: true })).status, 403);
  assert.equal((await patch({ archived: 'yes' })).data.code, 'INVALID_REQUEST');

  const archived = await patch({ archived: true });
  assert.equal(archived.status, 200);
  assert.equal(typeof archived.data.archived_at, 'number');
  assert.equal((await me()).archived, true);
  const again = await patch({ archived: true });
  assert.equal(again.data.archived_at, archived.data.archived_at, 'archiving twice keeps the first timestamp');

  const restored = await patch({ archived: false });
  assert.equal(restored.data.archived_at, null);
  assert.equal((await me()).archived, false);
  await patch({ archived: true });

  const actions = (await owner('GET', '/api/admin/audit?limit=100')).data.items.map(e => e.action);
  assert.ok(actions.includes('event.archive') && actions.includes('event.unarchive'));
  assert.equal(actions.filter(a => a === 'event.archive').length, 2, 'the repeated archive was not logged');
});

test('an archived event refuses scans', async () => {
  const before = app.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;
  for (const who of [ev.scanner, ev.admin]) {
    const res = await who('POST', '/api/scan', { code: codes[1] });
    assert.equal(res.data.status, 'ERROR');
    assert.equal(res.data.code, 'EVENT_ARCHIVED');
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, before, 'nothing is recorded');
  assert.equal((await other.scanner('POST', '/api/scan', { code: otherCode })).data.status, 'OK', 'other events are unaffected');
});

test('an archived event refuses every change', async () => {
  const png = { raw: Buffer.from([1, 2, 3]), headers: { 'Content-Type': 'image/png' } };
  const csv = { raw: Buffer.from(`UUID,Name\n${codes[2]},Someone\n`), headers: { 'Content-Type': 'text/csv' } };
  const writes = [
    ['PATCH', `/api/events/${ev.id}`, { reset_time: '05:00' }],
    ['POST', `/api/events/${ev.id}/sections`, { name: 'New' }],
    ['PATCH', `/api/sections/${section.id}`, { name: 'Renamed' }],
    ['DELETE', `/api/sections/${section.id}`],
    ['POST', `/api/sections/${section.id}/subsections`, { name: 'Another' }],
    ['PATCH', `/api/subsections/${subsection.id}`, { name: 'Renamed' }],
    ['DELETE', `/api/subsections/${subsection.id}`],
    ['POST', `/api/sections/${section.id}/tickets`, { count: 1 }],
    ['PUT', `/api/events/${ev.id}/card`, { title: 'x', text: 'y' }],
    ['POST', `/api/events/${ev.id}/card/backdrop`, undefined, png],
    ['DELETE', `/api/events/${ev.id}/card/backdrop`],
    ['PATCH', `/api/tickets/${codes[2]}`, { holder: 'Someone' }],
    ['PATCH', `/api/tickets/${codes[2]}`, { revoked: true }],
    ['POST', `/api/events/${ev.id}/holders`, undefined, csv],
    ['POST', `/api/scans/${scanId}/void`],
  ];
  for (const [method, path, body, opts] of writes) {
    for (const who of [ev.admin, ev.scanner]) {
      if (who === ev.scanner && !path.startsWith('/api/scans/')) continue; // scanners have no write routes except undo
      const res = await who(method, path, body, opts);
      if (who === ev.scanner) { assert.ok(res.status === 403 || res.status === 409); continue; }
      assert.equal(res.status, 409, `${method} ${path}`);
      assert.equal(res.data.code, 'EVENT_ARCHIVED', `${method} ${path}`);
    }
  }
  const unchanged = (await ev.admin('GET', `/api/events/${ev.id}/tickets?q=${codes[2]}`)).data.items[0];
  assert.deepEqual([unchanged.holder, unchanged.revoked_at], ['', null]);
  assert.equal((await ev.admin('GET', `/api/sections/${section.id}/subsections`)).data.length, 1);
});

test('an archived event stays fully readable', async () => {
  const reads = [
    [ev.scanner, `/api/events/${ev.id}/dashboard`],
    [ev.scanner, `/api/events/${ev.id}/history`],
    [ev.scanner, `/api/sections/${section.id}/doubles`],
    [ev.admin, `/api/events/${ev.id}/scans`],
    [ev.admin, `/api/events/${ev.id}/scans.xlsx`],
    [ev.admin, `/api/events/${ev.id}/tickets`],
    [ev.admin, `/api/events/${ev.id}/tickets.xlsx`],
    [ev.admin, `/api/events/${ev.id}/card`],
    [ev.admin, `/api/events/${ev.id}/card/tickets`],
    [ev.admin, `/api/events/${ev.id}/card/xlsx`],
    [ev.admin, `/api/sections/${section.id}/tickets`],
    [ev.admin, `/api/tickets/${codes[0]}`],
  ];
  for (const [who, path] of reads) assert.equal((await who('GET', path)).status, 200, path);
});

test('the owner can still manage an archived event', async () => {
  assert.equal((await patch({ name: 'Archivable (2026)' })).status, 200);
  const user = await owner('POST', `/api/admin/events/${ev.id}/users`, { username: 'late-comer', password: 'late-comer-pw', role: 'SCANNER' });
  assert.equal(user.status, 201);
});

test('unarchiving makes the event writable again', async () => {
  await patch({ archived: false });
  assert.equal((await ev.scanner('POST', '/api/scan', { code: codes[3] })).data.status, 'OK');
  assert.equal((await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Open again' })).status, 201);
  assert.equal((await ev.scanner('POST', `/api/scans/${scanId}/void`)).status, 200);
  assert.equal((await ev.admin('PATCH', `/api/tickets/${codes[2]}`, { holder: 'Back' })).status, 200);
});

test('archiving and dates are audited', async () => {
  const entries = (await owner('GET', '/api/admin/audit?limit=200')).data.items;
  for (const action of ['event.archive', 'event.unarchive', 'event.dates']) {
    assert.ok(entries.some(e => e.action === action && e.target.startsWith('Archivable')), action);
  }
});
