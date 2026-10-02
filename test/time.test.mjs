import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetBoundary, dayBoundaries, isValidTimeZone, canonicalTimeZone, serverTimeZone,
} from '../server/time.js';

const iso = ms => new Date(ms).toISOString();
const at = (isoString, resetTime, zone) => iso(resetBoundary(resetTime, new Date(isoString), zone));

test('Europe/Berlin around the spring-forward day (23 hour day)', () => {
  // 2026-03-29: clocks jump 02:00 CET -> 03:00 CEST at 01:00Z
  assert.equal(at('2026-03-29T12:00:00Z', '00:00', 'Europe/Berlin'), '2026-03-28T23:00:00.000Z'); // midnight was still CET
  assert.equal(at('2026-03-30T12:00:00Z', '00:00', 'Europe/Berlin'), '2026-03-29T22:00:00.000Z'); // midnight is CEST
});

test('Europe/Berlin around the fall-back day (25 hour day)', () => {
  // 2026-10-25: clocks fall 03:00 CEST -> 02:00 CET at 01:00Z
  assert.equal(at('2026-10-25T12:00:00Z', '00:00', 'Europe/Berlin'), '2026-10-24T22:00:00.000Z'); // midnight was CEST
  assert.equal(at('2026-10-26T12:00:00Z', '00:00', 'Europe/Berlin'), '2026-10-25T23:00:00.000Z'); // midnight is CET
});

test('the boundary is today\'s reset time once passed, yesterday\'s before that', () => {
  assert.equal(at('2026-07-21T04:00:00Z', '06:30', 'Europe/Berlin'), '2026-07-20T04:30:00.000Z'); // 06:00 local
  assert.equal(at('2026-07-21T05:00:00Z', '06:30', 'Europe/Berlin'), '2026-07-21T04:30:00.000Z'); // 07:00 local
  assert.equal(at('2026-07-21T04:30:00Z', '06:30', 'Europe/Berlin'), '2026-07-21T04:30:00.000Z', 'exactly on the boundary counts as passed');
});

test('other zones, including half-hour offsets and extreme offsets', () => {
  assert.equal(at('2026-07-21T23:30:00Z', '00:00', 'America/New_York'), '2026-07-21T04:00:00.000Z');
  assert.equal(at('2026-07-21T23:30:00Z', '00:00', 'Asia/Kolkata'), '2026-07-21T18:30:00.000Z'); // already the 22nd there
  assert.equal(at('2026-07-21T23:30:00Z', '00:00', 'UTC'), '2026-07-21T00:00:00.000Z');
  assert.equal(at('2026-01-01T00:00:00Z', '00:00', 'Pacific/Kiritimati'), '2025-12-31T10:00:00.000Z'); // UTC+14
  assert.equal(at('2026-01-01T00:00:00Z', '00:00', 'Pacific/Pago_Pago'), '2025-12-31T11:00:00.000Z'); // UTC-11
});

test('the same instant has different boundaries in different zones', () => {
  const now = '2026-07-21T23:30:00Z';
  const berlin = resetBoundary('00:00', new Date(now), 'Europe/Berlin');
  const newYork = resetBoundary('00:00', new Date(now), 'America/New_York');
  assert.equal(iso(berlin), '2026-07-21T22:00:00.000Z');
  assert.notEqual(berlin, newYork);
});

test('calendar arithmetic around leap days and month starts', () => {
  assert.equal(at('2028-03-01T00:30:00Z', '00:00', 'Europe/Berlin'), '2028-02-29T23:00:00.000Z');
  assert.equal(at('2028-03-01T00:30:00Z', '23:00', 'Europe/Berlin'), '2028-02-29T22:00:00.000Z'); // yesterday = Feb 29
  assert.equal(at('2026-03-01T00:30:00Z', '23:00', 'Europe/Berlin'), '2026-02-28T22:00:00.000Z');
  assert.equal(at('2027-01-01T00:30:00Z', '23:30', 'UTC'), '2026-12-31T23:30:00.000Z');
});

test('a reset time that does not exist (DST gap) lands right after the gap', () => {
  // 02:30 does not exist in Berlin on 2026-03-29; the clock goes 01:59 CET -> 03:00 CEST at 01:00Z
  const ms = resetBoundary('02:30', new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin');
  assert.ok(ms >= Date.parse('2026-03-29T01:00:00Z') && ms < Date.parse('2026-03-29T02:00:00Z'), iso(ms));
});

test('a reset time that happens twice (DST overlap) picks one of the two valid instants', () => {
  const ms = resetBoundary('02:30', new Date('2026-10-25T12:00:00Z'), 'Europe/Berlin');
  assert.ok([Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T01:30:00Z')].includes(ms), iso(ms));
});

test('without a zone the legacy server-local behavior is kept', () => {
  const now = new Date('2026-07-21T10:00:00'); // local time
  for (const zone of ['', undefined]) {
    const b1 = new Date(resetBoundary('06:30', now, zone));
    assert.equal(b1.getDate(), 21);
    assert.equal(b1.getHours(), 6);
    assert.equal(b1.getMinutes(), 30);
    const b2 = new Date(resetBoundary('18:00', now, zone));
    assert.equal(b2.getDate(), 20);
    assert.equal(b2.getHours(), 18);
  }
});

test('dayBoundaries reports 23 and 25 hour days around DST changes', () => {
  const hours = list => list.slice(1).map((ms, i) => (ms - list[i]) / 3_600_000);

  const spring = dayBoundaries('00:00', 'Europe/Berlin', Date.parse('2026-03-27T12:00:00Z'), Date.parse('2026-04-01T00:00:00Z'));
  assert.deepEqual(spring.map(iso), [
    '2026-03-26T23:00:00.000Z', '2026-03-27T23:00:00.000Z', '2026-03-28T23:00:00.000Z',
    '2026-03-29T22:00:00.000Z', '2026-03-30T22:00:00.000Z', '2026-03-31T22:00:00.000Z',
  ]);
  assert.deepEqual(hours(spring), [24, 24, 23, 24, 24]);

  const fall = dayBoundaries('00:00', 'Europe/Berlin', Date.parse('2026-10-23T12:00:00Z'), Date.parse('2026-10-27T12:00:00Z'));
  assert.deepEqual(hours(fall), [24, 24, 25, 24]);
});

test('dayBoundaries starts at the boundary at or before the start and stops at the end', () => {
  const exact = dayBoundaries('06:00', 'UTC', Date.parse('2026-07-21T06:00:00Z'), Date.parse('2026-07-23T06:00:00Z'));
  assert.deepEqual(exact.map(iso), ['2026-07-21T06:00:00.000Z', '2026-07-22T06:00:00.000Z', '2026-07-23T06:00:00.000Z']);
  const before = dayBoundaries('06:00', 'UTC', Date.parse('2026-07-21T05:00:00Z'), Date.parse('2026-07-21T05:30:00Z'));
  assert.deepEqual(before.map(iso), ['2026-07-20T06:00:00.000Z']);
  assert.deepEqual(dayBoundaries('06:00', 'UTC', 2000, 1000), [], 'an inverted range is empty');
});

test('dayBoundaries works for the legacy server-local mode too', () => {
  const list = dayBoundaries('00:00', '', Date.parse('2026-07-20T12:00:00Z'), Date.parse('2026-07-24T12:00:00Z'));
  assert.ok(list.length >= 4);
  for (const ms of list) {
    const d = new Date(ms);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  }
  assert.deepEqual([...list].sort((a, b) => a - b), list);
});

test('time zone helpers', () => {
  assert.equal(isValidTimeZone('Europe/Berlin'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Base'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(42), false);

  assert.equal(canonicalTimeZone('europe/berlin'), 'Europe/Berlin');
  assert.equal(canonicalTimeZone('utc'), 'UTC');
  assert.equal(canonicalTimeZone('Mars/Base'), null);
  assert.equal(canonicalTimeZone(''), null);

  assert.ok(isValidTimeZone(serverTimeZone()), 'the server zone is a usable zone id');
});
