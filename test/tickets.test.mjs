import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev, other;
let alpha, beta, north, south;
let northCodes, southCodes, alphaDirect, betaDirect, otherCode;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Codes');
  other = await app.event(owner, 'Elsewhere');

  const section = async name => (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name })).data;
  alpha = await section('Alpha');
  beta = await section('Beta');
  north = (await ev.admin('POST', `/api/sections/${alpha.id}/subsections`, { name: 'North' })).data;
  south = (await ev.admin('POST', `/api/sections/${alpha.id}/subsections`, { name: 'South' })).data;
  const make = async (sec, count, subsection_id) =>
    (await ev.admin('POST', `/api/sections/${sec.id}/tickets`, { count, subsection_id })).data.uuids;
  northCodes = await make(alpha, 3, north.id);
  southCodes = await make(alpha, 2, south.id);
  alphaDirect = await make(alpha, 2);
  betaDirect = await make(beta, 2);

  const otherSection = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Gamma' })).data;
  otherCode = (await other.admin('POST', `/api/sections/${otherSection.id}/tickets`, { count: 1 })).data.uuids[0];
});

const list = (query = '') => ev.admin('GET', `/api/events/${ev.id}/tickets${query}`);

test('the code list pages through every code of the event with a total', async () => {
  const first = await list('?limit=4');
  assert.equal(first.status, 200);
  assert.equal(first.data.total, 9);
  assert.equal(first.data.items.length, 4);
  const second = await list('?limit=4&offset=4');
  const third = await list('?limit=4&offset=8');
  const all = [...first.data.items, ...second.data.items, ...third.data.items].map(i => i.uuid);
  assert.equal(new Set(all).size, 9, 'paging visits every code once');
  assert.equal(third.data.items.length, 1);

  const item = first.data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'color', 'created_at', 'holder', 'revoked_at', 'scanned_today', 'section', 'section_id', 'subsection', 'subsection_id', 'uuid',
  ]);
  assert.equal(item.section, 'Alpha');
  assert.equal(item.holder, '');
  assert.equal(item.revoked_at, null);
  assert.ok(!all.includes(otherCode), 'codes of other events never show up');

  assert.ok((await list('?limit=100000')).data.items.length <= 200, 'the page size is capped');
  assert.equal((await list('?limit=abc&offset=-5')).status, 200, 'bad paging values fall back to defaults');
});

test('the code list filters by section, subsection and direct codes', async () => {
  assert.equal((await list(`?section=${alpha.id}`)).data.total, 7);
  assert.equal((await list(`?section=${beta.id}`)).data.total, 2);
  assert.equal((await list(`?subsection=${north.id}`)).data.total, 3);
  assert.equal((await list(`?section=${alpha.id}&subsection=none`)).data.total, 2);
  assert.equal((await list('?subsection=none')).data.total, 4);
});

test('the code list searches by uuid fragment and holder name', async () => {
  const code = northCodes[0];
  assert.ok((await list(`?q=${code.slice(0, 8)}`)).data.items.some(i => i.uuid === code));
  assert.ok((await list(`?q=${code.slice(0, 8).toUpperCase()}`)).data.items.some(i => i.uuid === code), 'case-insensitive');
  assert.ok((await list(`?q=%20${code}%20`)).data.items.some(i => i.uuid === code), 'surrounding spaces are ignored');
  assert.equal((await list('?q=zzzzzzzz')).data.total, 0);

  await ev.admin('PATCH', `/api/tickets/${southCodes[0]}`, { holder: 'Erika Mustermann' });
  await ev.admin('PATCH', `/api/tickets/${southCodes[1]}`, { holder: '100% Crew_A' });
  const byName = await list('?q=mustermann');
  assert.deepEqual(byName.data.items.map(i => i.uuid), [southCodes[0]]);
  assert.equal(byName.data.items[0].holder, 'Erika Mustermann');

  // % and _ are literal characters, not wildcards
  assert.deepEqual((await list('?q=%25')).data.items.map(i => i.uuid), [southCodes[1]]);
  assert.deepEqual((await list('?q=crew_a')).data.items.map(i => i.uuid), [southCodes[1]]);
  assert.equal((await list('?q=crewXa')).data.total, 0);
});

test('only event admins of the event may list codes', async () => {
  assert.equal((await ev.scanner('GET', `/api/events/${ev.id}/tickets`)).status, 403);
  assert.equal((await owner('GET', `/api/events/${ev.id}/tickets`)).status, 403);
  const foreign = await other.admin('GET', `/api/events/${ev.id}/tickets`);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await app.as(null)('GET', `/api/events/${ev.id}/tickets`)).status, 401);
});

test('holders can be set, trimmed and cleared', async () => {
  const code = alphaDirect[0];
  const set = await ev.admin('PATCH', `/api/tickets/${code}`, { holder: '  Max Muster  ' });
  assert.equal(set.status, 200);
  assert.equal(set.data.holder, 'Max Muster');
  assert.equal(set.data.uuid, code);
  assert.equal(set.data.section, 'Alpha');

  const upper = await ev.admin('PATCH', `/api/tickets/${code.toUpperCase()}`, { holder: 'Max Muster' });
  assert.equal(upper.status, 200, 'the uuid in the path is case-insensitive');

  const cleared = await ev.admin('PATCH', `/api/tickets/${code}`, { holder: '' });
  assert.equal(cleared.data.holder, '');

  const tooLong = await ev.admin('PATCH', `/api/tickets/${code}`, { holder: 'n'.repeat(101) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.data.code, 'HOLDER_TOO_LONG');
  assert.equal((await ev.admin('PATCH', `/api/tickets/${code}`, { holder: 5 })).data.code, 'HOLDER_INVALID');
  assert.equal((await ev.admin('PATCH', `/api/tickets/${code}`, { revoked: 'yes' })).data.code, 'INVALID_REQUEST');
  assert.equal((await ev.admin('PATCH', `/api/tickets/${code}`, {})).data.code, 'NOTHING_TO_UPDATE');
});

test('ticket updates are limited to the event admins of the ticket\'s event', async () => {
  const code = betaDirect[0];
  assert.equal((await ev.scanner('PATCH', `/api/tickets/${code}`, { holder: 'x' })).status, 403);
  assert.equal((await owner('PATCH', `/api/tickets/${code}`, { holder: 'x' })).status, 403);
  const foreign = await other.admin('PATCH', `/api/tickets/${code}`, { holder: 'x' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  const unknown = await ev.admin('PATCH', '/api/tickets/00000000-0000-4000-8000-000000000000', { holder: 'x' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'TICKET_NOT_FOUND');
  assert.equal((await ev.admin('PATCH', '/api/tickets/not-a-uuid', { holder: 'x' })).data.code, 'TICKET_NOT_FOUND');
});

test('revoking blocks a code, restoring brings it back', async () => {
  const code = betaDirect[1];
  await ev.admin('PATCH', `/api/tickets/${code}`, { holder: 'Pat Pending' });

  const revoked = await ev.admin('PATCH', `/api/tickets/${code}`, { revoked: true });
  assert.equal(revoked.status, 200);
  assert.equal(typeof revoked.data.revoked_at, 'number');
  const again = await ev.admin('PATCH', `/api/tickets/${code}`, { revoked: true });
  assert.equal(again.data.revoked_at, revoked.data.revoked_at, 'revoking twice keeps the first timestamp');

  const scan = await ev.scanner('POST', '/api/scan', { code });
  assert.equal(scan.data.status, 'REVOKED');
  assert.equal(scan.data.code, 'CODE_REVOKED');
  assert.equal(scan.data.uuid, code);
  assert.equal(scan.data.section, 'Beta');
  assert.equal(scan.data.holder, 'Pat Pending');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE ticket_uuid = ?').get(code).n, 0, 'nothing is recorded');

  assert.equal((await list('?status=revoked')).data.total, 1);
  assert.equal((await list('?status=active')).data.total, 8);

  const restored = await ev.admin('PATCH', `/api/tickets/${code}`, { revoked: false });
  assert.equal(restored.data.revoked_at, null);
  const ok = await ev.scanner('POST', '/api/scan', { code });
  assert.equal(ok.data.status, 'OK');
  assert.equal(ok.data.holder, 'Pat Pending', 'the holder is part of the scan response');
});

test('a revoked code of another event is reported as not authorized, not as revoked', async () => {
  await other.admin('PATCH', `/api/tickets/${otherCode}`, { revoked: true });
  const scan = await ev.scanner('POST', '/api/scan', { code: otherCode });
  assert.equal(scan.data.status, 'ERROR');
  assert.equal(scan.data.code, 'NOT_AUTHORIZED_EVENT');
});

test('scan responses only carry a holder when there is one, duplicates included', async () => {
  const named = northCodes[0];
  const anonymous = northCodes[1];
  await ev.admin('PATCH', `/api/tickets/${named}`, { holder: 'Nora North' });

  const first = await ev.scanner('POST', '/api/scan', { code: named });
  assert.equal(first.data.holder, 'Nora North');
  const plain = await ev.scanner('POST', '/api/scan', { code: anonymous });
  assert.equal(plain.data.status, 'OK');
  assert.ok(!('holder' in plain.data));

  const double = await ev.admin('POST', '/api/scan', { code: named });
  assert.equal(double.data.status, 'DOUBLE');
  assert.equal(double.data.holder, 'Nora North');
});

test('the per-section code list includes holder and revoked state', async () => {
  const rows = (await ev.admin('GET', `/api/sections/${beta.id}/tickets`)).data;
  assert.ok(rows.every(r => 'holder' in r && 'revoked_at' in r));
  assert.equal(rows.find(r => r.uuid === betaDirect[1]).holder, 'Pat Pending');
});

test('revoking and restoring are written to the audit log', async () => {
  const entries = (await owner('GET', '/api/admin/audit?limit=200')).data.items;
  const revokes = entries.filter(e => e.action === 'ticket.revoke');
  const restores = entries.filter(e => e.action === 'ticket.restore');
  assert.ok(revokes.some(e => e.target === betaDirect[1] && e.username === `admin${ev.id}`));
  assert.ok(restores.some(e => e.target === betaDirect[1]));
  assert.equal(revokes.filter(e => e.target === betaDirect[1]).length, 1, 'the repeated revoke changed nothing and is not logged');
});
