import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { describeResult } = await import('../public/js/scan-result.js');
const { t, hasKey, setLang } = await import('../public/js/i18n.js');

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ctx = () => ({ t, hasKey, locale: 'en-GB', timeZone: 'Europe/Berlin' });
const describe = result => describeResult(result, ctx());
const texts = d => d.parts.map(p => [p.cls, p.text]);

beforeEach(() => setLang('en'));

test('an accepted scan shows the number and the section', () => {
  const d = describe({ status: 'OK', scan_number: 12, uuid: UUID, section: 'Audio Video', scan_id: 7 });
  assert.equal(d.kind, 'ok');
  assert.equal(d.scanId, 7);
  assert.deepEqual(texts(d), [['big', 'OK'], ['num', '12'], ['detail', 'Audio Video']]);
});

test('the holder name is shown prominently when there is one', () => {
  const d = describe({ status: 'OK', scan_number: 3, uuid: UUID, section: 'Parking – North', holder: 'Anna Audio', scan_id: 1 });
  assert.deepEqual(texts(d), [['big', 'OK'], ['num', '3'], ['holder', 'Anna Audio'], ['detail', 'Parking – North']]);
});

test('a duplicate shows when and by whom the code was scanned first', () => {
  const first = Date.UTC(2026, 6, 21, 10, 3, 5); // 12:03:05 in Berlin
  const d = describe({ status: 'DOUBLE', uuid: UUID, section: 'Audio Video', holder: 'Anna Audio', first_scanned_at: first, first_scanned_by: 'gate-2', scan_id: 9 });
  assert.equal(d.kind, 'double');
  assert.equal(d.scanId, 9);
  assert.deepEqual(texts(d), [
    ['big', 'Duplicate!'],
    ['holder', 'Anna Audio'],
    ['detail', 'Audio Video'],
    ['detail', 'This code was already scanned:'],
    ['uuid', UUID],
    ['detail', 'First scan: 12:03:05 by gate-2'],
  ]);
});

test('a duplicate without a known first scanner or time stays readable', () => {
  const noName = describe({ status: 'DOUBLE', uuid: UUID, section: 'S', first_scanned_at: Date.UTC(2026, 6, 21, 10, 3, 5), first_scanned_by: null });
  assert.equal(texts(noName).at(-1)[1], 'First scan: 12:03:05');
  const noTime = describe({ status: 'DOUBLE', uuid: UUID, section: 'S' });
  assert.ok(!texts(noTime).some(([, text]) => /First scan/.test(text)));
});

test('a revoked code is a distinct result with its holder', () => {
  const d = describe({ status: 'REVOKED', code: 'CODE_REVOKED', message: 'Code revoked', uuid: UUID, section: 'Audio Video', holder: 'Lost Badge' });
  assert.equal(d.kind, 'revoked');
  assert.equal(d.scanId, undefined);
  assert.deepEqual(texts(d), [
    ['big', 'Revoked!'], ['holder', 'Lost Badge'], ['detail', 'Audio Video'],
    ['detail', 'This code has been revoked.'], ['uuid', UUID],
  ]);
});

test('errors use the translation of their code, else the server text, else a generic one', () => {
  assert.deepEqual(texts(describe({ status: 'ERROR', code: 'UNKNOWN_CODE', message: 'Unknown code' })), [['big', 'Error'], ['detail', 'Unknown code.']]);
  assert.equal(describe({ status: 'ERROR', code: 'SOMETHING_NEW', message: 'Raw server text' }).parts[1].text, 'Raw server text');
  assert.equal(describe({ status: 'ERROR' }).parts[1].text, 'Invalid code');
  assert.equal(describe({ status: 'ERROR', code: 'UNKNOWN_CODE' }).kind, 'error');
});

test('a lost connection is its own result and says the scan was not recorded', () => {
  const d = describe({ status: 'OFFLINE' });
  assert.equal(d.kind, 'offline');
  assert.equal(d.scanId, undefined);
  assert.deepEqual(texts(d), [['big', 'No connection'], ['detail', 'The scan was not recorded. Check the connection and scan again.']]);
});

test('unknown statuses are shown as errors rather than crashing the scanner', () => {
  assert.equal(describe({ status: 'WHATEVER', message: 'huh' }).kind, 'error');
  assert.equal(describe({}).kind, 'error');
});

test('the result follows the interface language', () => {
  setLang('de');
  assert.equal(describe({ status: 'DOUBLE', uuid: UUID, section: 'S' }).parts[0].text, 'Doppelt!');
  assert.equal(describe({ status: 'REVOKED', uuid: UUID, section: 'S' }).parts[0].text, 'Gesperrt!');
  assert.equal(describe({ status: 'OFFLINE' }).parts[0].text, 'Keine Verbindung');
  const first = describe({ status: 'DOUBLE', uuid: UUID, section: 'S', first_scanned_at: Date.UTC(2026, 6, 21, 10, 3, 5), first_scanned_by: 'gate-2' });
  assert.match(first.parts.at(-1).text, /Erster Scan: 12:03:05 Uhr von gate-2/);
});
