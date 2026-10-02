import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';

let app, owner, ev;
let spareId;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
});

async function log(query = '') {
  const res = await owner('GET', `/api/admin/audit${query}`);
  assert.equal(res.status, 200);
  return res.data;
}

test('administration actions are recorded with actor, target and details', async () => {
  ev = await app.event(owner, 'Audited'); // event.create + two user.create + two assignments via event users

  const spare = await owner('POST', '/api/admin/users', { username: 'spare', password: 'pw-spare-12345', role: 'SCANNER' });
  spareId = spare.data.id;
  await owner('POST', `/api/admin/events/${ev.id}/assignments`, { userId: spareId });
  await owner('DELETE', `/api/admin/events/${ev.id}/assignments/${spareId}`);

  const section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Parking' })).data;
  const sub = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'North' })).data;
  await ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 5, subsection_id: sub.id });
  await ev.admin('PATCH', `/api/events/${ev.id}`, { reset_time: '04:30' });
  await ev.admin('DELETE', `/api/subsections/${sub.id}`);
  await ev.admin('DELETE', `/api/sections/${section.id}`);
  await owner('DELETE', `/api/admin/users/${spareId}`);
  await owner('DELETE', `/api/admin/events/${ev.id}`);

  const { items } = await log('?limit=200');
  const actions = items.map(i => i.action).reverse(); // oldest first
  assert.deepEqual(actions, [
    'event.create',
    'user.create', 'assignment.add', // admin account created inside the event
    'user.create', 'assignment.add', // scanner account created inside the event
    'user.create',                   // spare
    'assignment.add', 'assignment.remove',
    'section.create', 'subsection.create', 'tickets.generate', 'event.settings',
    'subsection.delete', 'section.delete', 'user.delete', 'event.delete',
  ]);

  const byAction = name => items.find(i => i.action === name);
  assert.equal(byAction('event.create').username, 'owner');
  assert.equal(byAction('event.create').target, 'Audited');
  assert.equal(byAction('section.create').username, `admin${ev.id}`);
  assert.equal(byAction('section.create').target, 'Parking');
  assert.equal(byAction('section.create').event_id, ev.id);
  assert.deepEqual(byAction('tickets.generate').details, { count: 5, subsection: 'North' });
  assert.deepEqual(byAction('event.settings').details, { reset_time: '04:30' });
  assert.deepEqual(byAction('subsection.delete').details, { section: 'Parking', tickets: 5 });
  assert.equal(byAction('user.delete').target, 'spare');
  assert.equal(byAction('event.delete').target, 'Audited');
});

test('the log is newest first and pages with before / next_before', async () => {
  const all = (await log('?limit=200')).items.map(i => i.id);
  assert.deepEqual(all, [...all].sort((a, b) => b - a));

  const seen = [];
  let before;
  for (let page = 0; page < 20; page++) {
    const res = await log(`?limit=4${before ? `&before=${before}` : ''}`);
    assert.ok(res.items.length <= 4);
    seen.push(...res.items.map(i => i.id));
    if (res.next_before === null) break;
    before = res.next_before;
  }
  assert.deepEqual(seen, all, 'paging visits every entry exactly once, in order');
});

test('entries outlive the events and accounts they mention', async () => {
  const before = app.db.prepare("SELECT user_id, username FROM audit_log WHERE action = 'section.create'").get();
  assert.ok(before.user_id, 'the actor is linked while the account exists');

  const users = (await owner('GET', '/api/admin/users')).data;
  const adminAccount = users.find(u => u.username === `admin${ev.id}`);
  assert.equal((await owner('DELETE', `/api/admin/users/${adminAccount.id}`)).status, 200);

  const after = app.db.prepare("SELECT user_id, username FROM audit_log WHERE action = 'section.create'").get();
  assert.equal(after.user_id, null, 'the link is cleared when the account is deleted');
  assert.equal(after.username, `admin${ev.id}`, 'but the name stays readable');
  assert.ok((await log('?limit=200')).items.some(i => i.action === 'event.delete'), 'the deleted event is still in the log');
});

test('only the owner can read the log', async () => {
  const other = await app.event(owner, 'Another');
  assert.equal((await other.admin('GET', '/api/admin/audit')).status, 403);
  assert.equal((await other.scanner('GET', '/api/admin/audit')).status, 403);
  assert.equal((await app.as(null)('GET', '/api/admin/audit')).status, 401);
});

test('limit is clamped and invalid values fall back to the default', async () => {
  assert.ok((await log('?limit=0')).items.length >= 1);
  assert.ok((await log('?limit=abc')).items.length >= 1);
  assert.ok((await log('?limit=100000')).items.length <= 200);
});
