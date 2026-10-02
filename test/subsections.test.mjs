import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, ev, other, section, subA, subB;
let codesA, codesB, codesDirect;

before(async () => {
  app = await startTestApp();
  const owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Subsections');
  other = await app.event(owner, 'Somebody else');

  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Security' })).data;
  subA = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'Entrance' })).data;
  subB = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'Floor' })).data;
  const make = async (count, subsection_id) =>
    (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count, subsection_id })).data.uuids;
  codesA = await make(3, subA.id);
  codesB = await make(1, subB.id);
  codesDirect = await make(2, undefined);
});

test('deleting a subsection deletes its codes and their scans', async () => {
  assert.equal((await ev.scanner('POST', '/api/scan', { code: codesA[0] })).data.status, 'OK');

  // the other event's admin may not touch it
  assert.equal((await other.admin('DELETE', `/api/subsections/${subA.id}`)).status, 403);
  // scanners may not delete anything
  assert.equal((await ev.scanner('DELETE', `/api/subsections/${subA.id}`)).status, 403);

  const res = await ev.admin('DELETE', `/api/subsections/${subA.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, deleted_tickets: 3 });

  const remaining = (await ev.admin('GET', `/api/sections/${section.id}/tickets`)).data.map(t => t.uuid).sort();
  assert.deepEqual(remaining, [...codesB, ...codesDirect].sort(), 'only the other codes are left');

  const scan = await ev.scanner('POST', '/api/scan', { code: codesA[1] });
  assert.equal(scan.data.status, 'ERROR', 'a deleted code no longer scans');

  const orphanScans = app.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE ticket_uuid = ?').get(codesA[0]).n;
  assert.equal(orphanScans, 0, 'scan history of the deleted codes is removed with them');
});

test('other subsections and direct codes are untouched', async () => {
  assert.equal((await ev.scanner('POST', '/api/scan', { code: codesB[0] })).data.status, 'OK');
  assert.equal((await ev.scanner('POST', '/api/scan', { code: codesDirect[0] })).data.status, 'OK');
  const subs = (await ev.admin('GET', `/api/sections/${section.id}/subsections`)).data;
  assert.deepEqual(subs.map(s => s.name), ['Floor']);
});

test('deleting an unknown subsection is a 404', async () => {
  assert.equal((await ev.admin('DELETE', `/api/subsections/${subA.id}`)).status, 404);
});
