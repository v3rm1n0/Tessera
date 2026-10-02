import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev, other, gate2, section, codes;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Voids');
  other = await app.event(owner, 'Elsewhere');
  await owner('POST', `/api/admin/events/${ev.id}/users`, { username: 'gate2', password: 'pw-gate2-12345', role: 'SCANNER' });
  gate2 = await app.login('gate2', 'pw-gate2-12345');

  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Gate' })).data;
  codes = (await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 24 })).data.uuids;
});

const scan = (who, code) => who('POST', '/api/scan', { code }).then(r => r.data);
const dashboard = async () => (await ev.scanner('GET', `/api/events/${ev.id}/dashboard`)).data.sections[0];
let next = 0;
const fresh = () => codes[next++];

test('scan responses carry the id of the recorded scan', async () => {
  const code = fresh();
  const ok = await scan(ev.scanner, code);
  assert.equal(ok.status, 'OK');
  assert.ok(Number.isInteger(ok.scan_id) && ok.scan_id > 0);

  const repeat = await scan(ev.scanner, code); // debounced re-read by the same user
  assert.equal(repeat.status, 'OK');
  assert.equal(repeat.scan_id, ok.scan_id);

  const double = await scan(gate2, code);
  assert.equal(double.status, 'DOUBLE');
  assert.ok(Number.isInteger(double.scan_id) && double.scan_id !== ok.scan_id);
});

test('a duplicate names who scanned the code first', async () => {
  const code = fresh();
  await scan(ev.scanner, code);
  const double = await scan(gate2, code);
  assert.equal(double.first_scanned_by, `scanner${ev.id}`);
  assert.equal(typeof double.first_scanned_at, 'number');
});

test('first_scanned_by is null once that account is gone', async () => {
  await owner('POST', `/api/admin/events/${ev.id}/users`, { username: 'temp-gate', password: 'pw-temp-12345', role: 'SCANNER' });
  const temp = await app.login('temp-gate', 'pw-temp-12345');
  const code = fresh();
  assert.equal((await scan(temp, code)).status, 'OK');
  const users = (await owner('GET', '/api/admin/users')).data;
  await owner('DELETE', `/api/admin/users/${users.find(u => u.username === 'temp-gate').id}`);
  const double = await scan(ev.scanner, code);
  assert.equal(double.status, 'DOUBLE');
  assert.equal(double.first_scanned_by, null);
});

test('voiding your own scan lets the code be scanned again, and numbers never repeat', async () => {
  const [a, b, c, d] = [fresh(), fresh(), fresh(), fresh()];
  const first = await scan(gate2, a);
  const second = await scan(gate2, b);
  const third = await scan(gate2, c);
  assert.deepEqual([second.scan_number - first.scan_number, third.scan_number - second.scan_number], [1, 1]);

  const voided = await gate2('POST', `/api/scans/${second.scan_id}/void`);
  assert.equal(voided.status, 200);
  assert.deepEqual(voided.data, { ok: true });

  const fourth = await scan(gate2, d);
  assert.equal(fourth.scan_number, third.scan_number + 1, 'the voided number is not handed out again');

  const again = await scan(gate2, b); // same code, same user, well within the debounce window
  assert.equal(again.status, 'OK', 'a voided scan neither counts as a duplicate nor as a debounce hit');
  assert.equal(again.scan_number, fourth.scan_number + 1);
  assert.notEqual(again.scan_id, second.scan_id);

  const row = app.db.prepare('SELECT voided_at, voided_by FROM scans WHERE id = ?').get(second.scan_id);
  assert.equal(typeof row.voided_at, 'number');
  assert.ok(row.voided_by > 0);
});

test('voided scans do not count on the dashboard or in the duplicate list', async () => {
  const before = await dashboard();
  const code = fresh();
  const ok = await scan(ev.scanner, code);
  const double = await scan(gate2, code);
  assert.equal((await dashboard()).scans_today, before.scans_today + 1);
  assert.equal((await dashboard()).doubles_today, before.doubles_today + 1);

  assert.equal((await ev.admin('POST', `/api/scans/${double.scan_id}/void`)).status, 200);
  assert.equal((await dashboard()).doubles_today, before.doubles_today, 'the voided duplicate is gone');
  const doubles = (await ev.scanner('GET', `/api/sections/${section.id}/doubles`)).data.doubles;
  assert.ok(!doubles.some(d => d.uuid === code));

  assert.equal((await ev.scanner('POST', `/api/scans/${ok.scan_id}/void`)).status, 200);
  assert.equal((await dashboard()).scans_today, before.scans_today, 'the voided entry is gone');
});

test('a scanner may only void their own scans; event admins may void any', async () => {
  const code = fresh();
  const ok = await scan(ev.scanner, code);
  const denied = await gate2('POST', `/api/scans/${ok.scan_id}/void`);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'NOT_AUTHORIZED');
  assert.equal((await ev.admin('POST', `/api/scans/${ok.scan_id}/void`)).status, 200);
});

test('scanners can only undo within a minute; event admins are not limited', async () => {
  const [a, b] = [fresh(), fresh()];
  const sa = await scan(ev.scanner, a);
  const sb = await scan(ev.scanner, b);
  app.db.prepare('UPDATE scans SET scanned_at = scanned_at - ? WHERE id IN (?, ?)').run(2 * 60_000, sa.scan_id, sb.scan_id);

  const late = await ev.scanner('POST', `/api/scans/${sa.scan_id}/void`);
  assert.equal(late.status, 403);
  assert.equal(late.data.code, 'UNDO_EXPIRED');
  assert.equal((await ev.admin('POST', `/api/scans/${sb.scan_id}/void`)).status, 200);
});

test('a scan can only be voided once', async () => {
  const ok = await scan(ev.scanner, fresh());
  assert.equal((await ev.scanner('POST', `/api/scans/${ok.scan_id}/void`)).status, 200);
  const again = await ev.scanner('POST', `/api/scans/${ok.scan_id}/void`);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'ALREADY_VOIDED');
});

test('voiding checks the event, the id and the role', async () => {
  const ok = await scan(ev.scanner, fresh());
  const foreign = await other.admin('POST', `/api/scans/${ok.scan_id}/void`);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  const missing = await ev.admin('POST', '/api/scans/999999/void');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'SCAN_NOT_FOUND');
  assert.equal((await owner('POST', `/api/scans/${ok.scan_id}/void`)).status, 403);
  assert.equal((await app.as(null)('POST', `/api/scans/${ok.scan_id}/void`)).status, 401);
});

test('the code list shows whether a code was scanned today, ignoring voided scans', async () => {
  const code = fresh();
  const find = async () => (await ev.admin('GET', `/api/events/${ev.id}/tickets?q=${code}`)).data.items[0];
  assert.equal((await find()).scanned_today, false);
  const ok = await scan(ev.scanner, code);
  assert.equal((await find()).scanned_today, true);
  await ev.scanner('POST', `/api/scans/${ok.scan_id}/void`);
  assert.equal((await find()).scanned_today, false);
});

test('voiding is written to the audit log', async () => {
  const entries = (await owner('GET', '/api/admin/audit?limit=200')).data.items.filter(e => e.action === 'scan.void');
  assert.ok(entries.length >= 4);
  assert.ok(entries.every(e => /^[0-9a-f-]{36}$/.test(e.target) && e.details?.result));
});
