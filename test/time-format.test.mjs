import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInZone } from '../public/js/time-format.js';

const INSTANT = Date.UTC(2026, 6, 21, 22, 30); // 22:30Z
const CLOCK = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

test('formats an instant on the wall clock of the given zone', () => {
  assert.equal(formatInZone(INSTANT, CLOCK, 'Europe/Berlin', 'en-GB'), '00:30');
  assert.equal(formatInZone(INSTANT, CLOCK, 'America/New_York', 'en-GB'), '18:30');
  assert.equal(formatInZone(INSTANT, CLOCK, 'Asia/Kolkata', 'en-GB'), '04:00');
});

test('the date part follows the zone too', () => {
  const date = { year: 'numeric', month: '2-digit', day: '2-digit' };
  assert.equal(formatInZone(INSTANT, date, 'UTC', 'en-GB'), '21/07/2026');
  assert.equal(formatInZone(INSTANT, date, 'Europe/Berlin', 'en-GB'), '22/07/2026');
});

test('an unknown or missing zone falls back to the runtime zone instead of throwing', () => {
  const expected = new Date(INSTANT).toLocaleString('en-GB', CLOCK);
  assert.equal(formatInZone(INSTANT, CLOCK, 'Mars/Base', 'en-GB'), expected);
  assert.equal(formatInZone(INSTANT, CLOCK, undefined, 'en-GB'), expected);
  assert.equal(formatInZone(INSTANT, CLOCK, '', 'en-GB'), expected);
});

test('the locale decides the wording', () => {
  const day = { weekday: 'long' };
  assert.equal(formatInZone(INSTANT, day, 'UTC', 'en-GB'), 'Tuesday');
  assert.equal(formatInZone(INSTANT, day, 'UTC', 'de-DE'), 'Dienstag');
});
