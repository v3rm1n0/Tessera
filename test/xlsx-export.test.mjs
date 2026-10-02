import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, ev;

before(async () => {
  app = await startTestApp();
  const owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Sheet names');
});

test('excel export copes with section names that collide as sheet names', async () => {
  const names = [
    'Audio', 'audio',                         // case-only difference (DB uniqueness is case-sensitive)
    'History',                                // reserved by Excel
    'Gate A/B', 'Gate A?B',                   // illegal characters collapse to the same name
    `${'x'.repeat(40)}1`, `${'x'.repeat(40)}2`, // same first 31 characters
    "'quoted'",                               // leading/trailing apostrophe is illegal
  ];
  for (const name of names) {
    assert.equal((await ev.admin('POST', `/api/events/${ev.id}/sections`, { name })).status, 201, name);
  }

  const res = await ev.admin('GET', `/api/events/${ev.id}/tickets.xlsx`);
  assert.equal(res.status, 200);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.data);
  const sheetNames = wb.worksheets.map(w => w.name);
  assert.equal(sheetNames.length, names.length, 'one sheet per section');
  assert.equal(new Set(sheetNames.map(n => n.toLowerCase())).size, names.length, 'sheet names are unique');
  assert.ok(sheetNames.every(n => n.length <= 31), 'sheet names fit Excel\'s limit');
  assert.ok(!sheetNames.includes('History'), 'reserved name is avoided');

  // the process must still be alive and answering
  assert.equal((await ev.admin('GET', '/api/me')).status, 200);
});
