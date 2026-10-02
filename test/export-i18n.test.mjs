import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ENGLISH = ['Section', 'Subsection', 'UUID', 'Created', 'Name (recipient)'];
const GERMAN = ['Abteilung', 'Unterabteilung', 'UUID', 'Erstellt', 'Name (Empfänger)'];

let owner, ev, blank, uuids;

before(async () => {
  const app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Export languages');
  blank = await app.event(owner, 'Nothing yet');
  const section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Audio' })).data;
  const sub = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'Team' })).data;
  uuids = (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 3, subsection_id: sub.id })).data.uuids;
});

const load = buffer => new ExcelJS.Workbook().xlsx.load(buffer);
const header = sheet => sheet.getRow(1).values.slice(1);
const codeExport = (query = '') => ev.admin('GET', `/api/events/${ev.id}/tickets.xlsx${query}`).then(r => load(r.data));

test('the code export has German headers on request', async () => {
  const book = await codeExport('?lang=de');
  assert.deepEqual(header(book.worksheets[0]), GERMAN);
});

test('English is the default, and anything but "de" falls back to it', async () => {
  for (const query of ['', '?lang=en', '?lang=fr', '?lang=DE', '?lang=', '?lang=de%00']) {
    const book = await codeExport(query);
    assert.deepEqual(header(book.worksheets[0]), ENGLISH, query || '(no lang)');
  }
});

test('the per-folder lists of the card export follow the language too', async () => {
  const german = (await ev.admin('GET', `/api/events/${ev.id}/card/xlsx?lang=de`)).data.groups;
  const english = (await ev.admin('GET', `/api/events/${ev.id}/card/xlsx`)).data.groups;
  const fromGroup = async group => (await load(Buffer.from(group.base64, 'base64'))).worksheets[0];
  assert.deepEqual(header(await fromGroup(german[0])), ['Abteilung', 'UUID', 'Name (Empfänger)']);
  assert.deepEqual(header(await fromGroup(english[0])), ['Section', 'UUID', 'Name (recipient)']);
});

test('an event without sections exports a sheet with a translated name', async () => {
  const get = query => blank.admin('GET', `/api/events/${blank.id}/tickets.xlsx${query}`).then(r => load(r.data));
  assert.equal((await get('')).worksheets[0].name, 'Empty');
  assert.equal((await get('?lang=de')).worksheets[0].name, 'Leer');
});

for (const [lang, headers] of [['de', GERMAN], ['en', ENGLISH]]) {
  test(`an export in ${lang === 'de' ? 'German' : 'English'} can be filled in and uploaded again`, async () => {
    const book = await codeExport(`?lang=${lang}`);
    const sheet = book.worksheets[0];
    assert.deepEqual(header(sheet), headers);
    const name = `Holder ${lang}`;
    const row = sheet.getRows(2, 3).find(r => r.getCell(3).value === uuids[0]);
    row.getCell(5).value = name;
    const bytes = Buffer.from(await book.xlsx.writeBuffer());

    const uploaded = await ev.admin('POST', `/api/events/${ev.id}/holders`, undefined, { raw: bytes, headers: { 'Content-Type': XLSX } });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal((await ev.admin('GET', `/api/tickets/${uuids[0]}`)).data.ticket.holder, name);
  });
}
