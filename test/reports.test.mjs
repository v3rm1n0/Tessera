import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { resetBoundary, wallClockDate } from '../server/time.js';

const DAY = 24 * 3_600_000;
let app, owner, ev, other, gate2, section, subsection, otherSection, codes, otherCode;
let scanIds; // ids of the scans made in the fixture, oldest first

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Reports');
  other = await app.event(owner, 'Elsewhere');
  await owner('POST', `/api/admin/events/${ev.id}/users`, { username: 'gate2', password: 'pw-gate2-12345', role: 'SCANNER' });
  gate2 = await app.login('gate2', 'pw-gate2-12345');

  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Security' })).data;
  subsection = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'North' })).data;
  const sectionB = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Parking' })).data;
  const make = async (sec, count, subsection_id) =>
    (await ev.admin('POST', `/api/sections/${sec.id}/tickets`, { count, subsection_id })).data.uuids;
  codes = [...await make(section, 3, subsection.id), ...await make(section, 2), ...await make(sectionB, 2)];
  await ev.admin('PATCH', `/api/tickets/${codes[0]}`, { holder: 'Nora North' });
  await ev.admin('PATCH', `/api/tickets/${codes[5]}`, { holder: 'Paula Parking' });

  otherSection = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Gamma' })).data;
  otherCode = (await other.admin('POST', `/api/sections/${otherSection.id}/tickets`, { count: 1 })).data.uuids[0];

  // five entries, one duplicate (by another scanner), one entry voided again
  scanIds = [];
  for (const code of codes.slice(0, 5)) scanIds.push((await ev.scanner('POST', '/api/scan', { code })).data.scan_id);
  const double = await gate2('POST', '/api/scan', { code: codes[0] });
  scanIds.push(double.data.scan_id);
  const lastEntry = await ev.scanner('POST', '/api/scan', { code: codes[5] });
  scanIds.push(lastEntry.data.scan_id);
  await ev.scanner('POST', `/api/scans/${lastEntry.data.scan_id}/void`);
});

const log = (query = '', who = ev.admin) => who('GET', `/api/events/${ev.id}/scans${query}`);

test('the scan log lists every scan, newest first, with who and what', async () => {
  const res = await log('?limit=200');
  assert.equal(res.status, 200);
  assert.equal(res.data.items.length, 7);
  assert.equal(res.data.next_before, null);
  assert.deepEqual(res.data.items.map(i => i.id), [...scanIds].reverse());

  const newest = res.data.items[0];
  assert.deepEqual(Object.keys(newest).sort(), [
    'at', 'holder', 'id', 'result', 'scan_number', 'scanner', 'section', 'subsection', 'uuid', 'voided_at',
  ]);
  assert.equal(newest.uuid, codes[5]);
  assert.equal(newest.holder, 'Paula Parking');
  assert.equal(newest.section, 'Parking');
  assert.equal(newest.scanner, `scanner${ev.id}`);
  assert.equal(typeof newest.voided_at, 'number', 'voided scans stay in the log, marked');

  const double = res.data.items.find(i => i.result === 'DOUBLE');
  assert.equal(double.scanner, 'gate2');
  assert.equal(double.uuid, codes[0]);
  assert.equal(double.scan_number, null);

  const first = res.data.items.find(i => i.uuid === codes[0] && i.result === 'OK');
  assert.equal(first.subsection, 'North');
  assert.equal(first.holder, 'Nora North');
  assert.equal(first.voided_at, null);
});

test('the scan log pages with before / next_before', async () => {
  const seen = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const res = await log(`?limit=3${before ? `&before=${before}` : ''}`);
    assert.ok(res.data.items.length <= 3);
    seen.push(...res.data.items.map(i => i.id));
    if (res.data.next_before === null) break;
    assert.equal(res.data.next_before, res.data.items.at(-1).id);
    before = res.data.next_before;
  }
  assert.deepEqual(seen, [...scanIds].reverse());
});

test('the scan log filters by result, search text and day', async () => {
  const doubles = (await log('?result=DOUBLE')).data.items;
  assert.equal(doubles.length, 1);
  assert.equal((await log('?result=OK')).data.items.length, 6);
  assert.equal((await log('?result=nonsense')).data.items.length, 7, 'an unknown result filter is ignored');

  assert.deepEqual((await log(`?q=${codes[1].slice(0, 8)}`)).data.items.map(i => i.uuid), [codes[1]]);
  assert.equal((await log('?q=nora')).data.items.length, 2, 'search finds the holder: the entry and the duplicate');
  assert.equal((await log('?q=%25')).data.items.length, 0, 'wildcards are literal');

  const event = (await ev.admin('GET', '/api/me')).data.events[0];
  const today = resetBoundary(event.reset_time, undefined, event.timezone);
  assert.equal((await log(`?day=${today}`)).data.items.length, 7);
  assert.equal((await log(`?day=${today + 1000}`)).data.items.length, 7, 'any instant inside the day selects it');
  assert.equal((await log(`?day=${today - 2 * DAY}`)).data.items.length, 0);
});

test('only event admins of the event may read the scan log', async () => {
  assert.equal((await log('', ev.scanner)).status, 403);
  assert.equal((await log('', owner)).status, 403);
  const foreign = await log('', other.admin);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await log('', app.as(null))).status, 401);
});

test('lookup returns a code with its scan history', async () => {
  const res = await ev.admin('GET', `/api/tickets/${codes[0]}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.ticket, {
    uuid: codes[0], event_id: ev.id, section_id: section.id, section: 'Security', color: section.color,
    subsection: 'North', holder: 'Nora North', revoked_at: null, created_at: res.data.ticket.created_at,
  });
  assert.deepEqual(res.data.scans.map(s => [s.result, s.scanner]), [['DOUBLE', 'gate2'], ['OK', `scanner${ev.id}`]]);
  assert.deepEqual(Object.keys(res.data.scans[0]).sort(), ['at', 'id', 'result', 'scan_number', 'scanner', 'voided_at']);
});

test('lookup accepts the short form of a code', async () => {
  const [a, b] = [codes[0].slice(0, 13), codes[0].replaceAll('-', '').slice(0, 12).toUpperCase()];
  for (const input of [a, b, `${codes[0].slice(0, 18)}`]) {
    const res = await ev.admin('GET', `/api/tickets/${encodeURIComponent(input)}`);
    assert.equal(res.status, 200, input);
    assert.equal(res.data.ticket.uuid, codes[0]);
  }
});

test('lookup reports short, unknown, foreign and ambiguous codes', async () => {
  const tooShort = await ev.admin('GET', `/api/tickets/${codes[0].slice(0, 8)}`);
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.data.code, 'INVALID_CODE');

  const unknown = await ev.admin('GET', '/api/tickets/00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'TICKET_NOT_FOUND');

  const foreign = await ev.admin('GET', `/api/tickets/${otherCode}`);
  assert.equal(foreign.status, 404, 'a code of another event does not exist for this admin');
  assert.equal(foreign.data.code, 'TICKET_NOT_FOUND');

  // a second code that shares the first 12 hex digits with codes[3], inserted directly
  const twin = `${codes[3].slice(0, 13)}-aaaa-aaaa-aaaaaaaaaaaa`;
  app.db.prepare('INSERT INTO tickets (uuid, section_id) VALUES (?, ?)').run(twin, section.id);
  try {
    const clash = await ev.admin('GET', `/api/tickets/${codes[3].slice(0, 13)}`);
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, 'CODE_AMBIGUOUS');
    const narrowed = await ev.admin('GET', `/api/tickets/${codes[3].slice(0, 18)}`);
    assert.equal(narrowed.status, 200, 'more characters tell the two apart');
    assert.equal(narrowed.data.ticket.uuid, codes[3]);
  } finally {
    app.db.prepare('DELETE FROM tickets WHERE uuid = ?').run(twin);
  }
});

test('lookup is limited to event admins', async () => {
  assert.equal((await ev.scanner('GET', `/api/tickets/${codes[0]}`)).status, 403);
  assert.equal((await owner('GET', `/api/tickets/${codes[0]}`)).status, 403);
  assert.equal((await app.as(null)('GET', `/api/tickets/${codes[0]}`)).status, 401);
});

async function workbook(query = '') {
  const res = await ev.admin('GET', `/api/events/${ev.id}/scans.xlsx${query}`);
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.data);
  return { wb, res, sheet: wb.getWorksheet('Scans') || wb.worksheets[0] };
}

test('the attendance export is an excel sheet with one row per scan, oldest first', async () => {
  const { sheet, res } = await workbook();
  assert.ok(res.headers.get('content-type').includes('spreadsheetml'));
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="scans-event-${ev.id}.xlsx"`);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    'Time', 'Section', 'Subsection', 'UUID', 'Name', 'Result', 'Scan no.', 'Scanner', 'Voided',
  ]);
  assert.equal(sheet.rowCount, 1 + 7);

  const rows = [];
  sheet.eachRow((row, n) => { if (n > 1) rows.push(row.values.slice(1)); });
  assert.deepEqual(rows.map(r => r[3]), [codes[0], codes[1], codes[2], codes[3], codes[4], codes[0], codes[5]], 'oldest first');
  assert.equal(rows[0][1], 'Security');
  assert.equal(rows[0][2], 'North');
  assert.equal(rows[0][4], 'Nora North');
  assert.equal(rows[0][5], 'OK');
  assert.equal(rows[5][5], 'Duplicate');
  assert.equal(rows[5][7], 'gate2');
  assert.equal(rows[0][8] ?? '', '', 'not voided');
  assert.ok(rows[6][8], 'the voided entry says so');

  const event = (await ev.admin('GET', '/api/me')).data.events[0];
  const stamp = app.db.prepare('SELECT scanned_at FROM scans WHERE id = ?').get(scanIds[0]).scanned_at;
  const shown = rows[0][0].getTime();
  assert.ok(Math.abs(shown - wallClockDate(stamp, event.timezone).getTime()) < 1000, 'times are shown on the wall clock of the event zone');
});

test('the attendance export can be restricted to a day and localized', async () => {
  const event = (await ev.admin('GET', '/api/me')).data.events[0];
  const today = resetBoundary(event.reset_time, undefined, event.timezone);
  const empty = await workbook(`?day=${today - 3 * DAY}`);
  assert.equal(empty.sheet.rowCount, 1, 'only the header row');
  const dayLabel = new Intl.DateTimeFormat('en-CA', { timeZone: event.timezone }).format(new Date(today - 3 * DAY));
  assert.equal(empty.res.headers.get('content-disposition'), `attachment; filename="scans-event-${ev.id}-${dayLabel}.xlsx"`);

  const german = await workbook('?lang=de');
  assert.deepEqual(german.sheet.getRow(1).values.slice(1), [
    'Zeit', 'Abteilung', 'Unterabteilung', 'UUID', 'Name', 'Ergebnis', 'Scan-Nr.', 'Scanner', 'Rückgängig',
  ]);
  assert.equal(german.sheet.getRow(7).getCell(6).value, 'Doppelt');

  const fallback = await workbook('?lang=fr');
  assert.equal(fallback.sheet.getRow(1).getCell(1).value, 'Time');
});

test('the attendance export is limited to event admins', async () => {
  assert.equal((await ev.scanner('GET', `/api/events/${ev.id}/scans.xlsx`)).status, 403);
  assert.equal((await other.admin('GET', `/api/events/${ev.id}/scans.xlsx`)).status, 403);
});
