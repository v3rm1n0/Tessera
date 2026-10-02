import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { safeName, sectionKey, subsectionKey, folderNames, filterTickets, scopeOptions, exportZip } from '../public/js/card-export.js';

const ticket = (uuid, section_id, section, subsection_id = null, subsection = null) =>
  ({ uuid, section_id, section, subsection_id, subsection, color: '#4f9cf5' });
const pngOf = uuid => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(uuid)]); // different bytes per card
const render = async tk => pngOf(tk.uuid);
const zipOf = async blob => JSZip.loadAsync(await blob.arrayBuffer());
const filesIn = async blob => Object.keys((await zipOf(blob)).files).filter(name => !name.endsWith('/')).sort();

// ---------------------------------------------------------------- names

test('safeName keeps letters, digits, dash and underscore, and never yields a path trick or nothing', () => {
  assert.equal(safeName('Crew 1'), 'Crew_1');
  assert.equal(safeName('Ärzte & Co.'), 'Ärzte_Co_');
  assert.equal(safeName('Ordnungsdienst – Innenraum'), 'Ordnungsdienst_Innenraum');
  assert.equal(safeName('../../etc/passwd'), '_etc_passwd');
  assert.equal(safeName('..'), '_');
  assert.equal(safeName(''), '_');
  assert.equal(safeName(undefined), '_');
});

test('folder names are unique among siblings, ignoring case, with a numbered suffix', () => {
  const names = folderNames([
    ticket('a', 1, 'Crew 1'),
    ticket('b', 2, 'Crew_1'),      // sanitizes to the same name
    ticket('c', 3, 'Crew'),
    ticket('d', 4, 'crew'),        // differs only in case: one folder on macOS and Windows
    ticket('e', 5, 'Crew_1_2'),    // literally the name the second one just received
    ticket('f', 1, 'Crew 1'),      // the same section again: still one folder
  ]);
  assert.equal(names.get(sectionKey(1)), 'Crew_1');
  assert.equal(names.get(sectionKey(2)), 'Crew_1_2');
  assert.equal(names.get(sectionKey(3)), 'Crew');
  assert.equal(names.get(sectionKey(4)), 'crew_2');
  assert.equal(names.get(sectionKey(5)), 'Crew_1_2_2');
  assert.equal(new Set([...names.values()].map(n => n.toLowerCase())).size, 5);
});

test('subsection folders only have to be unique within their section', () => {
  const names = folderNames([
    ticket('a', 1, 'Audio', 10, 'Team 1'),
    ticket('b', 1, 'Audio', 11, 'Team_1'),
    ticket('c', 2, 'Video', 20, 'Team 1'),
    ticket('d', 1, 'Audio'),
  ]);
  assert.equal(names.get(subsectionKey(1, 10)), 'Team_1');
  assert.equal(names.get(subsectionKey(1, 11)), 'Team_1_2');
  assert.equal(names.get(subsectionKey(2, 20)), 'Team_1');
  assert.equal(names.get(sectionKey(1)), 'Audio');
});

// ---------------------------------------------------------------- scope

const SCOPED = [
  ticket('a', 1, 'Audio'),
  ticket('b', 1, 'Audio', 10, 'Team'),
  ticket('c', 1, 'Audio', 11, 'Crew'),
  ticket('d', 2, 'Video'),
];

test('a scope narrows the cards to a section, a subsection, or the codes without subsection', () => {
  const uuids = scope => filterTickets(SCOPED, scope).map(tk => tk.uuid);
  assert.deepEqual(uuids(undefined), ['a', 'b', 'c', 'd']);
  assert.deepEqual(uuids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(uuids({ section_id: 1 }), ['a', 'b', 'c'], 'a section includes its subsections');
  assert.deepEqual(uuids({ section_id: 1, subsection_id: 10 }), ['b']);
  assert.deepEqual(uuids({ section_id: 1, subsection_id: null }), ['a'], 'null means: directly in the section');
  assert.deepEqual(uuids({ section_id: 99 }), []);
});

test('the scope choices list each section with its total, its subsections, and its direct codes when it has both', () => {
  const groups = [
    { section_id: 1, section: 'Audio', subsection_id: null, subsection: null, count: 4 },
    { section_id: 1, section: 'Audio', subsection_id: 10, subsection: 'Team', count: 3 },
    { section_id: 1, section: 'Audio', subsection_id: 11, subsection: 'Crew', count: 2 },
    { section_id: 2, section: 'Video', subsection_id: null, subsection: null, count: 5 },
    { section_id: 3, section: 'Light', subsection_id: 30, subsection: 'Front', count: 1 },
  ];
  assert.deepEqual(scopeOptions(groups), [
    { scope: { section_id: 1 }, count: 9, section: 'Audio', subsection: null },
    { scope: { section_id: 1, subsection_id: 10 }, count: 3, section: 'Audio', subsection: 'Team' },
    { scope: { section_id: 1, subsection_id: 11 }, count: 2, section: 'Audio', subsection: 'Crew' },
    { scope: { section_id: 1, subsection_id: null }, count: 4, section: 'Audio', subsection: null, direct: true },
    { scope: { section_id: 2 }, count: 5, section: 'Video', subsection: null },
    { scope: { section_id: 3 }, count: 1, section: 'Light', subsection: null },
    { scope: { section_id: 3, subsection_id: 30 }, count: 1, section: 'Light', subsection: 'Front' },
  ]);
  assert.deepEqual(scopeOptions([]), []);
  // every option selects exactly its count of tickets
  const tickets = groups.flatMap(g => Array.from({ length: g.count }, (_, i) => ({ uuid: `${g.section_id}-${g.subsection_id}-${i}`, section_id: g.section_id, subsection_id: g.subsection_id })));
  for (const option of scopeOptions(groups)) assert.equal(filterTickets(tickets, option.scope).length, option.count, JSON.stringify(option.scope));
});

// ---------------------------------------------------------------- the zip

test('cards land in Section/Subsection folders, named by their uuid, bytes intact', async () => {
  const tickets = [
    ticket('11111111-0000-4000-8000-000000000001', 1, 'Audio'),
    ticket('11111111-0000-4000-8000-000000000002', 1, 'Audio', 10, 'Team'),
    ticket('11111111-0000-4000-8000-000000000003', 2, 'Crew 1'),
    ticket('11111111-0000-4000-8000-000000000004', 3, 'Crew_1'),
  ];
  const blob = await exportZip({ tickets, renderCard: render, JSZip });
  assert.deepEqual(await filesIn(blob), [
    'Audio/11111111-0000-4000-8000-000000000001.png',
    'Audio/Team/11111111-0000-4000-8000-000000000002.png',
    'Crew_1/11111111-0000-4000-8000-000000000003.png',
    'Crew_1_2/11111111-0000-4000-8000-000000000004.png',
  ]);
  const zip = await zipOf(blob);
  const bytes = await zip.file('Audio/Team/11111111-0000-4000-8000-000000000002.png').async('uint8array');
  assert.deepEqual([...bytes], [...pngOf('11111111-0000-4000-8000-000000000002')]);
});

test('progress is reported after every card', async () => {
  const calls = [];
  await exportZip({ tickets: SCOPED, renderCard: render, JSZip, onProgress: (done, total) => calls.push([done, total]) });
  assert.deepEqual(calls, [[1, 4], [2, 4], [3, 4], [4, 4]]);
});

test('cancelling stops the rendering and rejects with an AbortError', async () => {
  const tickets = Array.from({ length: 20 }, (_, i) => ticket(`u${i}`, 1, 'Audio'));
  const controller = new AbortController();
  let rendered = 0;
  const promise = exportZip({
    tickets, JSZip, signal: controller.signal,
    renderCard: async tk => { rendered++; return pngOf(tk.uuid); },
    onProgress: done => { if (done === 3) controller.abort(); },
  });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(rendered, 3, 'no card was rendered after the cancel');
});

test('a cancel before the start renders nothing, and one while packing returns nothing', async () => {
  const early = new AbortController();
  early.abort();
  let rendered = 0;
  await assert.rejects(exportZip({ tickets: SCOPED, JSZip, signal: early.signal, renderCard: async tk => { rendered++; return pngOf(tk.uuid); } }), { name: 'AbortError' });
  assert.equal(rendered, 0);

  const late = new AbortController();
  await assert.rejects(
    exportZip({ tickets: SCOPED, JSZip, renderCard: render, signal: late.signal, onProgress: done => { if (done === SCOPED.length) late.abort(); } }),
    { name: 'AbortError' });
});

test('the packing step is announced once, after the last card', async () => {
  const events = [];
  await exportZip({ tickets: SCOPED, renderCard: render, JSZip, onProgress: done => events.push(`card ${done}`), onPack: () => events.push('pack') });
  assert.deepEqual(events, ['card 1', 'card 2', 'card 3', 'card 4', 'pack']);
});

test('a card that cannot be rendered fails the export instead of leaving a gap', async () => {
  const failing = async tk => { if (tk.uuid === 'c') throw new Error('PNG encoding failed'); return pngOf(tk.uuid); };
  await assert.rejects(exportZip({ tickets: SCOPED, renderCard: failing, JSZip }), /PNG encoding failed/);
});

test('the per-folder code lists go into the folders that are exported, and only those', async () => {
  const sheet = text => ({ base64: Buffer.from(text).toString('base64') });
  const xlsxGroups = [
    { section_id: 1, subsection_id: null, ...sheet('audio') },
    { section_id: 1, subsection_id: 10, ...sheet('team') },
    { section_id: 2, subsection_id: null, ...sheet('video') },
    { section_id: 9, subsection_id: null, ...sheet('not exported') },
  ];
  const tickets = filterTickets(SCOPED, { section_id: 1 });
  const blob = await exportZip({ tickets, renderCard: render, JSZip, xlsxGroups });
  // the lists of the exported folders are in; Video and the unknown section 9 have none, Crew has no list to place
  assert.deepEqual(await filesIn(blob), [
    'Audio/Crew/c.png',
    'Audio/Team/UUIDs.xlsx',
    'Audio/Team/b.png',
    'Audio/UUIDs.xlsx',
    'Audio/a.png',
  ]);
  const zip = await zipOf(blob);
  assert.equal(await zip.file('Audio/Team/UUIDs.xlsx').async('string'), 'team');
});

test('a code list is placed only when one of its codes is exported', async () => {
  const sheet = text => ({ base64: Buffer.from(text).toString('base64') });
  const xlsxGroups = [
    { section_id: 1, subsection_id: null, ...sheet('direct codes of Audio') },
    { section_id: 1, subsection_id: 10, ...sheet('team') },
  ];
  const onlyTeam = filterTickets(SCOPED, { section_id: 1, subsection_id: 10 });
  const blob = await exportZip({ tickets: onlyTeam, renderCard: render, JSZip, xlsxGroups });
  assert.deepEqual(await filesIn(blob), ['Audio/Team/UUIDs.xlsx', 'Audio/Team/b.png'], 'the section folder exists, but its direct codes are not part of this export');
});

test('nothing to export is an empty archive, not a crash', async () => {
  const blob = await exportZip({ tickets: [], renderCard: render, JSZip });
  assert.deepEqual(await filesIn(blob), []);
});
