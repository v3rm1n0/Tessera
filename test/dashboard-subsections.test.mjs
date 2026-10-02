import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, ev, section, subA, subB, codesA, codesB, codesDirect;

before(async () => {
  app = await startTestApp();
  const owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Dashboard');
  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Crew' })).data;
  subA = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'A-Team' })).data;
  subB = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'B-Team' })).data;
  const make = async (count, subsection_id) =>
    (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count, subsection_id })).data.uuids;
  codesA = await make(3, subA.id);
  codesB = await make(2, subB.id);
  codesDirect = await make(2, undefined);
});

const sections = async () => (await ev.scanner('GET', `/api/events/${ev.id}/dashboard`)).data.sections;
const byName = (list, name) => list.find(s => s.name === name);

test('subsections report their own ticket and scan counts', async () => {
  for (const code of [codesA[0], codesA[1], codesDirect[0]]) {
    assert.equal((await ev.scanner('POST', '/api/scan', { code })).data.status, 'OK');
  }
  const [crew] = await sections();
  assert.equal(crew.scans_today, 3);
  assert.deepEqual(crew.subsections.map(s => [s.name, s.ticket_count, s.scans_today]), [
    ['A-Team', 3, 2],
    ['B-Team', 2, 0],
  ]);
  assert.equal(byName(crew.subsections, 'A-Team').id, subA.id);
});

test('duplicates and voided scans do not count towards a subsection', async () => {
  // a duplicate scan of an A-Team code by another user is recorded as DOUBLE, not as an entry
  const double = await ev.admin('POST', '/api/scan', { code: codesA[0] });
  assert.equal(double.data.status, 'DOUBLE');
  assert.equal(byName((await sections())[0].subsections, 'A-Team').scans_today, 2);

  // voiding one of the A-Team entries takes it off the count
  const again = await ev.scanner('POST', '/api/scan', { code: codesA[2] });
  assert.equal(byName((await sections())[0].subsections, 'A-Team').scans_today, 3);
  assert.equal((await ev.scanner('POST', `/api/scans/${again.data.scan_id}/void`)).status, 200);
  assert.equal(byName((await sections())[0].subsections, 'A-Team').scans_today, 2);
  assert.equal((await sections())[0].scans_today, 3, 'the section total follows');
});

test('only scans of today count for a subsection', async () => {
  app.db.prepare("UPDATE scans SET scanned_at = scanned_at - 3 * 86400000 WHERE ticket_uuid = ?").run(codesA[1]);
  assert.equal(byName((await sections())[0].subsections, 'A-Team').scans_today, 1);
});

test('a section without subsections has an empty list', async () => {
  const lone = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Loners' })).data;
  const list = await sections();
  assert.deepEqual(byName(list, lone.name).subsections, []);
});

test('subsections are listed in case-insensitive name order, whatever order they were created in', async () => {
  const ordered = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Ordered' })).data;
  for (const name of ['Zulu', 'alpha', 'Mike']) {
    await ev.admin('POST', `/api/sections/${ordered.id}/subsections`, { name });
  }
  const list = await sections();
  assert.deepEqual(byName(list, 'Ordered').subsections.map(s => s.name), ['alpha', 'Mike', 'Zulu']);
});
