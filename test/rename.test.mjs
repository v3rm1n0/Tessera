import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev, other, alpha, beta, north, south, code;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Original');
  other = await app.event(owner, 'Elsewhere');
  alpha = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Alpha' })).data;
  beta = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Beta' })).data;
  north = (await ev.admin('POST', `/api/sections/${alpha.id}/subsections`, { name: 'North' })).data;
  south = (await ev.admin('POST', `/api/sections/${alpha.id}/subsections`, { name: 'South' })).data;
  await ev.admin('POST', `/api/sections/${beta.id}/subsections`, { name: 'North' });
  code = (await ev.admin('POST', `/api/sections/${alpha.id}/tickets`, { count: 1, subsection_id: north.id })).data.uuids[0];
  await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Gamma' });
});

const audit = async action => (await owner('GET', '/api/admin/audit?limit=200')).data.items.filter(e => e.action === action);

test('the owner can rename an event', async () => {
  const res = await owner('PATCH', `/api/admin/events/${ev.id}`, { name: '  Renamed Event  ' });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'Renamed Event');
  assert.equal(res.data.id, ev.id);
  assert.ok(!('card_backdrop' in res.data));
  assert.ok((await owner('GET', '/api/admin/events')).data.some(e => e.name === 'Renamed Event'));
  assert.equal((await ev.admin('GET', '/api/me')).data.events[0].name, 'Renamed Event');

  const entries = await audit('event.rename');
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].target, entries[0].details], ['Renamed Event', { from: 'Original' }]);

  await owner('PATCH', `/api/admin/events/${ev.id}`, { name: 'Renamed Event' });
  assert.equal((await audit('event.rename')).length, 1, 'renaming to the same name is not logged');
});

test('event renames are validated and owner-only', async () => {
  for (const name of [42, '   ', undefined, 'n'.repeat(101)]) {
    assert.equal((await owner('PATCH', `/api/admin/events/${ev.id}`, { name })).status, 400, JSON.stringify(name));
  }
  assert.equal((await owner('PATCH', '/api/admin/events/99999', { name: 'x' })).data.code, 'EVENT_NOT_FOUND');
  assert.equal((await ev.admin('PATCH', `/api/admin/events/${ev.id}`, { name: 'x' })).status, 403);
  assert.equal((await ev.scanner('PATCH', `/api/admin/events/${ev.id}`, { name: 'x' })).status, 403);
});

test('an event admin can rename a section; scan labels follow', async () => {
  const res = await ev.admin('PATCH', `/api/sections/${alpha.id}`, { name: '  Alpha Crew  ' });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'Alpha Crew');
  assert.equal(res.data.id, alpha.id);

  const scan = await ev.scanner('POST', '/api/scan', { code });
  assert.equal(scan.data.section, 'Alpha Crew – North');
  const dash = (await ev.scanner('GET', `/api/events/${ev.id}/dashboard`)).data;
  assert.ok(dash.sections.some(s => s.name === 'Alpha Crew'));

  const entries = await audit('section.rename');
  assert.deepEqual([entries[0].target, entries[0].details], ['Alpha Crew', { from: 'Alpha' }]);
});

test('section names stay unique per event, but not across events, and may change case', async () => {
  const clash = await ev.admin('PATCH', `/api/sections/${alpha.id}`, { name: 'Beta' });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.code, 'SECTION_EXISTS');
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: 'Gamma' })).status, 200, 'the other event\'s Gamma does not matter');
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: 'gamma' })).status, 200, 'only the case changes');
  const same = await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: 'gamma' });
  assert.equal(same.status, 200, 'renaming to the current name is a no-op');
});

test('a section can be renamed and recolored at once; an empty update is rejected', async () => {
  const res = await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: 'Beta Again', color: '#112233' });
  assert.deepEqual([res.data.name, res.data.color], ['Beta Again', '#112233']);
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { color: '#445566' })).data.name, 'Beta Again', 'color alone keeps the name');
  const empty = await ev.admin('PATCH', `/api/sections/${beta.id}`, {});
  assert.equal(empty.status, 400);
  assert.equal(empty.data.code, 'NOTHING_TO_UPDATE');
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: '' })).data.code, 'NAME_REQUIRED');
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { name: 'n'.repeat(101) })).data.code, 'NAME_TOO_LONG');
  assert.equal((await ev.admin('PATCH', `/api/sections/${beta.id}`, { color: 'red' })).data.code, 'COLOR_INVALID');
});

test('section renames are limited to event admins of the event', async () => {
  const foreign = await other.admin('PATCH', `/api/sections/${alpha.id}`, { name: 'Hacked' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await ev.scanner('PATCH', `/api/sections/${alpha.id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await owner('PATCH', `/api/sections/${alpha.id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await ev.admin('PATCH', '/api/sections/99999', { name: 'x' })).status, 404);
});

test('an event admin can rename a subsection; scan labels follow', async () => {
  const res = await ev.admin('PATCH', `/api/subsections/${north.id}`, { name: '  Entrance  ' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { id: north.id, section_id: alpha.id, name: 'Entrance' });
  const scan = await ev.scanner('POST', '/api/scan', { code: (await ev.admin('POST', `/api/sections/${alpha.id}/tickets`, { count: 1, subsection_id: north.id })).data.uuids[0] });
  assert.equal(scan.data.section, 'Alpha Crew – Entrance');

  const entries = await audit('subsection.rename');
  assert.deepEqual([entries[0].target, entries[0].details], ['Entrance', { from: 'North', section: 'Alpha Crew' }]);
});

test('subsection names stay unique per section only', async () => {
  const clash = await ev.admin('PATCH', `/api/subsections/${north.id}`, { name: 'South' });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.code, 'SUBSECTION_EXISTS');
  // Beta already has a "North"; renaming Alpha's South to North is fine
  assert.equal((await ev.admin('PATCH', `/api/subsections/${south.id}`, { name: 'North' })).status, 200);
  assert.equal((await ev.admin('PATCH', `/api/subsections/${south.id}`, {})).data.code, 'NAME_REQUIRED');
});

test('subsection renames are limited to event admins of the event', async () => {
  const foreign = await other.admin('PATCH', `/api/subsections/${north.id}`, { name: 'Hacked' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await ev.scanner('PATCH', `/api/subsections/${north.id}`, { name: 'Hacked' })).status, 403);
  const missing = await ev.admin('PATCH', '/api/subsections/99999', { name: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'SUBSECTION_NOT_FOUND');
});
