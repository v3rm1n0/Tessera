import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { parseHolderRows } from '../server/holders-import.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv';

let app, owner, ev, other, sectionA, sectionB, codes, otherCode;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Import');
  other = await app.event(owner, 'Elsewhere');
  sectionA = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Audio' })).data;
  sectionB = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Video' })).data;
  const make = async (sec, count) => (await ev.admin('POST', `/api/sections/${sec.id}/tickets`, { count })).data.uuids;
  codes = [...await make(sectionA, 12), ...await make(sectionB, 4)];
  const foreign = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Gamma' })).data;
  otherCode = (await other.admin('POST', `/api/sections/${foreign.id}/tickets`, { count: 1 })).data.uuids[0];
});

async function xlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const upload = (body, type = XLSX, who = ev.admin) =>
  who('POST', `/api/events/${ev.id}/holders`, undefined, { raw: body, headers: { 'Content-Type': type } });
const holderOf = async code => (await ev.admin('GET', `/api/events/${ev.id}/tickets?q=${code}`)).data.items[0].holder;

test('an excel sheet with English headers sets the holder names', async () => {
  const body = await xlsx({ UUIDs: [['Section', 'UUID', 'Name (recipient)'], ['Audio', codes[0], 'Anna'], ['Audio', codes[1], '  Bert  ']] });
  const res = await upload(body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[0]), 'Anna');
  assert.equal(await holderOf(codes[1]), 'Bert', 'names are trimmed');
});

test('German headers and extra columns work too', async () => {
  const body = await xlsx({ Blatt1: [
    ['Abteilung', 'Unterabteilung', 'UUID', 'Erstellt', 'Name (Empfänger)'],
    ['Audio', '', codes[2], '2026-07-21', 'Cora'],
    ['Audio', '', codes[3].toUpperCase(), '2026-07-21', 'Dirk'], // upper-case uuids are fine
  ] });
  const res = await upload(body);
  assert.deepEqual(res.data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[2]), 'Cora');
  assert.equal(await holderOf(codes[3]), 'Dirk');
});

test('a sheet without headers is read by finding the uuid column', async () => {
  const res = await upload(await xlsx({ S: [[codes[4], 'Eva'], [codes[5], 'Finn']] }));
  assert.deepEqual(res.data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[5]), 'Finn');
});

test('every sheet of a workbook is read', async () => {
  const body = await xlsx({
    Audio: [['UUID', 'Name (recipient)'], [codes[6], 'Gina']],
    Video: [['UUID', 'Name (recipient)'], [codes[12], 'Hugo']],
  });
  assert.deepEqual((await upload(body)).data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[12]), 'Hugo');
});

test('rich text and formula cells are read as their text', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(['UUID', 'Name (recipient)']);
  ws.addRow([codes[7], { richText: [{ text: 'Rich ' }, { text: 'Text', font: { bold: true } }] }]);
  ws.addRow([codes[8], { formula: '"Form"&"ula"', result: 'Formula' }]);
  const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(res.data.updated, 2);
  assert.equal(await holderOf(codes[7]), 'Rich Text');
  assert.equal(await holderOf(codes[8]), 'Formula');
});

test('the sheets exported by the app can be filled in and imported again', async () => {
  const exported = await ev.admin('GET', `/api/events/${ev.id}/tickets.xlsx`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exported.data);
  const sheet = wb.getWorksheet('Video');
  const header = sheet.getRow(1).values.slice(1);
  assert.ok(header.includes('Name (recipient)'), `the export has a name column: ${JSON.stringify(header)}`);
  const nameCol = header.indexOf('Name (recipient)') + 1;
  sheet.getRow(2).getCell(nameCol).value = 'Round Trip';
  const filled = sheet.getRow(2).getCell(header.indexOf('UUID') + 1).value;

  const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(res.status, 200);
  assert.ok(res.data.updated >= 1);
  assert.equal(await holderOf(filled), 'Round Trip');

  // and the export now shows the names it was given
  const again = new ExcelJS.Workbook();
  await again.xlsx.load((await ev.admin('GET', `/api/events/${ev.id}/tickets.xlsx`)).data);
  const names = [];
  again.eachSheet(s => s.eachRow((row, n) => { if (n > 1) names.push(row.getCell(nameCol).value); }));
  assert.ok(names.includes('Round Trip'));
});

test('the per-folder lists of the card export carry the holder names', async () => {
  const res = await ev.admin('GET', `/api/events/${ev.id}/card/xlsx`);
  const group = res.data.groups.find(g => g.section === 'Audio');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(group.base64, 'base64'));
  const rows = [];
  wb.getWorksheet('UUIDs').eachRow((row, n) => { if (n > 1) rows.push([row.getCell(2).value, row.getCell(3).value]); });
  assert.ok(rows.some(([uuid, name]) => uuid === codes[0] && name === 'Anna'));
  assert.ok(rows.some(([, name]) => name === ''), 'codes without a holder keep an empty cell to fill in');
});

test('a csv with semicolons, quotes and a byte order mark is read', async () => {
  const csv = '﻿Section;UUID;Name (recipient)\r\n'
    + `Audio;${codes[9]};"Meier; Max"\r\n`
    + `Audio;${codes[10]};"Anna ""Annie"" Schmidt"\r\n`;
  const res = await upload(Buffer.from(csv, 'utf8'), CSV);
  assert.deepEqual(res.data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[9]), 'Meier; Max');
  assert.equal(await holderOf(codes[10]), 'Anna "Annie" Schmidt');
});

test('a comma separated csv without a header is read too', async () => {
  const res = await upload(Buffer.from(`${codes[11]},Ida\n${codes[13]},Jan\n`), CSV);
  assert.deepEqual(res.data, { updated: 2, unknown: 0, skipped: 0 });
  assert.equal(await holderOf(codes[13]), 'Jan');
});

test('blank names are skipped and keep what is there', async () => {
  await ev.admin('PATCH', `/api/tickets/${codes[14]}`, { holder: 'Keep Me' });
  const res = await upload(Buffer.from(`UUID,Name\n${codes[14]},\n${codes[15]},New Name\n`), CSV);
  assert.deepEqual(res.data, { updated: 1, unknown: 0, skipped: 1 });
  assert.equal(await holderOf(codes[14]), 'Keep Me');
  assert.equal(await holderOf(codes[15]), 'New Name');
});

test('unknown codes are counted and codes of other events are left alone', async () => {
  const stranger = '00000000-0000-4000-8000-000000000000';
  const res = await upload(Buffer.from(`UUID,Name\n${stranger},Nobody\n${otherCode},Intruder\n`), CSV);
  assert.deepEqual(res.data, { updated: 0, unknown: 2, skipped: 0 });
  const foreign = await other.admin('GET', `/api/events/${other.id}/tickets?q=${otherCode}`);
  assert.equal(foreign.data.items[0].holder, '');
});

test('names longer than 100 characters are cut', async () => {
  await upload(Buffer.from(`UUID,Name\n${codes[0]},${'x'.repeat(150)}\n`), CSV);
  assert.equal((await holderOf(codes[0])).length, 100);
});

test('files that are not spreadsheets, or hold no codes, are rejected', async () => {
  const garbage = await upload(Buffer.from('this is not a spreadsheet at all'), XLSX);
  assert.equal(garbage.status, 400);
  assert.equal(garbage.data.code, 'IMPORT_INVALID');

  const headerOnly = await upload(await xlsx({ S: [['UUID', 'Name (recipient)']] }));
  assert.equal(headerOnly.status, 400);
  assert.equal(headerOnly.data.code, 'IMPORT_EMPTY');

  const noCodes = await upload(Buffer.from('a,b\nc,d\n'), CSV);
  assert.equal(noCodes.data.code, 'IMPORT_EMPTY');

  const empty = await upload(Buffer.alloc(0), CSV);
  assert.equal(empty.status, 400);
  assert.equal(empty.data.code, 'IMPORT_EMPTY');
});

test('uploads over 2 MB are refused', async () => {
  const res = await upload(Buffer.alloc(2 * 1024 * 1024 + 16, 97), CSV);
  assert.equal(res.status, 413);
  assert.equal(res.data.code, 'PAYLOAD_TOO_LARGE');
});

test('other file types are refused', async () => {
  const res = await upload(Buffer.from('%PDF-1.4'), 'application/pdf');
  assert.equal(res.status, 415);
  assert.equal(res.data.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('only event admins of the event may import', async () => {
  const body = Buffer.from(`UUID,Name\n${codes[0]},Mallory\n`);
  assert.equal((await upload(body, CSV, ev.scanner)).status, 403);
  assert.equal((await upload(body, CSV, owner)).status, 403);
  const foreign = await upload(body, CSV, other.admin);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  assert.equal((await upload(body, CSV, app.as(null))).status, 401);
  assert.notEqual(await holderOf(codes[0]), 'Mallory');
});

test('successful imports are written to the audit log, rejected ones are not', async () => {
  const entries = (await owner('GET', '/api/admin/audit?limit=200')).data.items.filter(e => e.action === 'holders.import');
  assert.equal(entries.length, 11, 'one entry per successful import');
  assert.ok(entries.every(e => e.username === `admin${ev.id}` && e.event_id === ev.id));
  assert.ok(entries.some(e => e.details.updated === 1 && e.details.skipped === 1), 'the import with a blank name');
  assert.ok(entries.some(e => e.details.updated === 0 && e.details.unknown === 2), 'the import of unknown codes');
});

test('parseHolderRows reads quoted fields with line breaks and any common delimiter', async () => {
  const body = Buffer.from(`UUID\tName\n${codes[0]}\t"Line one\nline two"\n`);
  assert.deepEqual(await parseHolderRows(body, CSV), [{ uuid: codes[0], name: 'Line one\nline two' }]);
  await assert.rejects(parseHolderRows(Buffer.from('x'), 'application/pdf'), /Unsupported/);
});
