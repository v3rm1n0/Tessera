import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev, other, gate2, section, codes, otherCodes;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Manual entry');
  other = await app.event(owner, 'Elsewhere');
  await owner('POST', `/api/admin/events/${ev.id}/users`, { username: 'gate2', password: 'pw-gate2-12345', role: 'SCANNER' });
  gate2 = await app.login('gate2', 'pw-gate2-12345');

  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Gate' })).data;
  codes = (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 12 })).data.uuids;
  const side = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Side door' })).data;
  otherCodes = (await other.admin('POST', `/api/sections/${side.id}/tickets`, { count: 2 })).data.uuids;
});

const scanAs = (who, code) => who('POST', '/api/scan', { code }).then(r => r.data);
const scan = code => scanAs(ev.scanner, code);
const recorded = () => app.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;
let next = 0;
const fresh = () => codes[next++];

test('the first 12 hex digits scan the ticket, whatever the case and separators', async () => {
  const uuid = fresh();
  const digits = uuid.replaceAll('-', '');
  const first = await scan(uuid.slice(0, 13));
  assert.equal(first.status, 'OK');
  assert.equal(first.uuid, uuid);

  const variants = [
    uuid.slice(0, 13).toUpperCase(),                     // 550E8400-E29B
    `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`, // 550e 8400 e29b
    `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`.toUpperCase(), // the grouping printed on cards
    `  ${digits.slice(0, 16)}  `,                        // longer prefixes work too
  ];
  for (const typed of variants) {
    const again = await scan(typed); // a re-read by the same scanner within seconds repeats the first result
    assert.equal(again.status, 'OK', typed);
    assert.equal(again.uuid, uuid, typed);
    assert.equal(again.scan_id, first.scan_id, typed);
  }
});

test('a full code is unchanged, in any case', async () => {
  const uuid = fresh();
  const ok = await scan(uuid.toUpperCase());
  assert.equal(ok.status, 'OK');
  assert.equal(ok.uuid, uuid);
  assert.equal((await scan(uuid)).scan_id, ok.scan_id);
});

test('a short code behaves like the full code afterwards: duplicates, holder, revoked', async () => {
  const uuid = fresh();
  await ev.admin('PATCH', `/api/tickets/${uuid}`, { holder: 'Anna Audio' });
  const ok = await scan(uuid.slice(0, 13));
  assert.equal(ok.status, 'OK');
  assert.equal(ok.holder, 'Anna Audio');

  const double = await scanAs(gate2, uuid.slice(0, 13).toUpperCase());
  assert.equal(double.status, 'DOUBLE');
  assert.equal(double.first_scanned_by, `scanner${ev.id}`);
  assert.equal(double.uuid, uuid);

  const revoked = fresh();
  await ev.admin('PATCH', `/api/tickets/${revoked}`, { revoked: true });
  const before = recorded();
  const refused = await scan(revoked.slice(0, 13));
  assert.equal(refused.status, 'REVOKED');
  assert.equal(recorded(), before);
});

test('fewer than 12 digits are invalid and record nothing', async () => {
  const uuid = fresh();
  const before = recorded();
  for (const typed of [uuid.replaceAll('-', '').slice(0, 11), uuid.slice(0, 8), 'abc', 'zzzzzzzzzzzz', '']) {
    const r = await scan(typed);
    assert.equal(r.status, 'ERROR', typed);
    assert.equal(r.code, 'INVALID_CODE', typed);
  }
  assert.equal(recorded(), before);
});

test('an unknown prefix is an unknown code', async () => {
  const r = await scan('ffffffff-ffff');
  assert.deepEqual([r.status, r.code], ['ERROR', 'UNKNOWN_CODE']);
});

test("a prefix of another event's ticket is unknown, while its full code is refused as before", async () => {
  const before = recorded();
  const prefix = await scan(otherCodes[0].slice(0, 13));
  assert.deepEqual([prefix.status, prefix.code], ['ERROR', 'UNKNOWN_CODE']);
  const full = await scan(otherCodes[0]);
  assert.deepEqual([full.status, full.code], ['ERROR', 'NOT_AUTHORIZED_EVENT']);
  assert.equal(recorded(), before);
});

test('an ambiguous prefix asks for more and records nothing; the full code still works', async () => {
  const a = 'abcdef12-3456-4000-8000-000000000001';
  const b = 'abcdef12-3456-4000-8000-000000000002';
  const insert = app.db.prepare('INSERT INTO tickets (uuid, section_id) VALUES (?, ?)');
  insert.run(a, section.id);
  insert.run(b, section.id);

  const before = recorded();
  const r = await scan('abcdef12-3456');
  assert.deepEqual([r.status, r.code], ['ERROR', 'CODE_AMBIGUOUS']);
  assert.match(r.message, /ambiguous/i);
  assert.equal(recorded(), before);

  assert.equal((await scan(a)).status, 'OK');
});

test('archived events refuse scans by short code as well', async () => {
  const old = await app.event(owner, 'Last year');
  const sec = (await old.admin('POST', `/api/events/${old.id}/sections`, { name: 'Gate' })).data;
  const [uuid] = (await old.admin('POST', `/api/sections/${sec.id}/tickets`, { count: 1 })).data.uuids;
  await owner('PATCH', `/api/admin/events/${old.id}`, { archived: true });
  const r = await scanAs(old.scanner, uuid.slice(0, 13));
  assert.deepEqual([r.status, r.code], ['ERROR', 'EVENT_ARCHIVED']);
});
