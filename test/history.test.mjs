import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { zonedParts, wallToInstant } from '../server/time.js';

const TZ = 'Europe/Berlin';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The instant at which Berlin's wall clock showed hh:mm, `daysAgo` calendar days before today. */
function local(daysAgo, hh, mm = 0) {
  const p = zonedParts(new Date(), TZ);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - daysAgo));
  return wallToInstant(TZ, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm);
}

let app, owner, ev, other, secA, secB, codes;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'History');
  other = await app.event(owner, 'Elsewhere');
  await ev.admin('PATCH', `/api/events/${ev.id}`, { reset_time: '06:00', timezone: TZ });

  secA = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Alpha' })).data;
  secB = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Beta' })).data;
  const make = async (sec, count) => (await ev.admin('POST', `/api/sections/${sec.id}/tickets`, { count })).data.uuids;
  codes = { a: await make(secA, 8), b: await make(secB, 3) };
});

const history = (who = ev.scanner) => who('GET', `/api/events/${ev.id}/history`);
const insertScan = (uuid, sectionId, result, at, { voided = false } = {}) => app.db.prepare(`
  INSERT INTO scans (ticket_uuid, section_id, result, scan_number, scanned_at, voided_at)
  VALUES (?, ?, ?, ?, ?, ?)`).run(uuid, sectionId, result, result === 'OK' ? 1 : null, at, voided ? at + 1 : null);

test('an event without scans has no days', async () => {
  const res = await history();
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.days, []);
  assert.deepEqual(res.data.event, { id: ev.id, name: 'History', reset_time: '06:00', timezone: TZ });
});

test('scans are grouped into event days that start at the reset time of the event zone', async () => {
  const [a1, a2, a3, a4, a5, a6] = codes.a;
  insertScan(a1, secA.id, 'OK', local(3, 5, 30));   // before the 06:00 reset -> belongs to the previous event day
  insertScan(a2, secA.id, 'OK', local(3, 6, 30));
  insertScan(a3, secA.id, 'OK', local(3, 11, 15));
  insertScan(codes.b[0], secB.id, 'OK', local(3, 11, 45));
  insertScan(a4, secA.id, 'DOUBLE', local(3, 12, 0));
  insertScan(a4, secA.id, 'DOUBLE', local(3, 12, 5)); // the same code twice: one duplicated code, two attempts
  insertScan(a5, secA.id, 'OK', local(3, 13, 0), { voided: true }); // voided: never counts
  insertScan(a6, secA.id, 'OK', local(1, 7, 0));

  const { days } = (await history()).data;
  const byStart = new Map(days.map(d => [d.start, d]));

  const previous = byStart.get(local(4, 6));
  assert.ok(previous, 'the day before the first full day is listed');
  assert.deepEqual([previous.ok, previous.doubles], [1, 0]);

  const day = byStart.get(local(3, 6));
  assert.ok(day, 'the day starting at 06:00 local is listed');
  assert.equal(day.end, local(2, 6), 'a day ends where the next one starts');
  assert.deepEqual([day.ok, day.doubles], [3, 1]);
  assert.deepEqual(day.sections, [
    { id: secA.id, name: 'Alpha', color: secA.color, ok: 2, doubles: 1 },
    { id: secB.id, name: 'Beta', color: secB.color, ok: 1, doubles: 0 },
  ]);
  assert.equal(day.hourly.length, Math.round((day.end - day.start) / HOUR), 'one slot per hour of the day');
  assert.equal(day.hourly[0], 1, '06:30 falls into the first hour');
  assert.equal(day.hourly[5], 2, '11:15 and 11:45 fall into the sixth hour');
  assert.equal(day.hourly.reduce((n, v) => n + v, 0), day.ok);

  const quiet = byStart.get(local(2, 6));
  assert.ok(quiet, 'days without scans between active days are listed too');
  assert.deepEqual([quiet.ok, quiet.doubles, quiet.sections], [0, 0, []]);
  assert.ok(quiet.hourly.every(v => v === 0));

  const recent = byStart.get(local(1, 6));
  assert.deepEqual([recent.ok, recent.sections.map(s => s.name)], [1, ['Alpha']]);

  const starts = days.map(d => d.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'newest day first');
});

test('voided scans alone do not start a history', async () => {
  const fresh = await app.event(owner, 'Only voided');
  const sec = (await fresh.admin('POST', `/api/events/${fresh.id}/sections`, { name: 'S' })).data;
  const [code] = (await fresh.admin('POST', `/api/sections/${sec.id}/tickets`, { count: 1 })).data.uuids;
  insertScan(code, sec.id, 'OK', local(2, 10), { voided: true });
  assert.deepEqual((await fresh.scanner('GET', `/api/events/${fresh.id}/history`)).data.days, []);
});

test('the history is capped at the most recent 62 days', async () => {
  insertScan(codes.a[7], secA.id, 'OK', Date.now() - 100 * DAY);
  const { days } = (await history()).data;
  assert.equal(days.length, 62);
  assert.ok(days[0].start > days[61].start);
  assert.ok(days.every(d => d.start >= Date.now() - 64 * DAY), 'older days are left out');
});

test('event admins and scanners of the event may read the history, nobody else', async () => {
  assert.equal((await history(ev.admin)).status, 200);
  assert.equal((await history(ev.scanner)).status, 200);
  assert.equal((await history(owner)).status, 403);
  const foreign = await history(other.scanner);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await history(app.as(null))).status, 401);
});
