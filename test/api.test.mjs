process.env.NODE_ENV = 'test';
process.env.OWNER_PASSWORD = 'test-owner-pw';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// dynamic imports so the env vars above are set before db.js initializes
const { seedOwner, db, resetBoundary } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');

let base;
const jars = {}; // per-user cookie jars

function client(name) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jars[name] ? { cookie: jars[name] } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) jars[name] = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}

const owner = client('owner');
const admin = client('admin');
const scanner = client('scanner');
const outsider = client('outsider');

let eventId, sectionId, uuids;

before(async () => {
  seedOwner();
  const app = createApp();
  await new Promise(resolve => {
    const srv = app.listen(0, () => {
      base = `http://localhost:${srv.address().port}`;
      resolve();
    });
    srv.unref(); // let the test process exit when the tests are done
  });
});

test('login rejects bad credentials', async () => {
  const r = await owner('POST', '/api/login', { username: 'owner', password: 'wrong' });
  assert.equal(r.status, 401);
});

test('owner can log in and create accounts + event', async () => {
  assert.equal((await owner('POST', '/api/login', { username: 'owner', password: 'test-owner-pw' })).status, 200);

  const ev = await owner('POST', '/api/admin/events', { name: 'Kongress 2026' });
  assert.equal(ev.status, 201);
  eventId = ev.data.id;

  assert.equal((await owner('POST', '/api/admin/users',
    { username: 'eva', password: 'pw-eva', role: 'EVENT_ADMIN' })).status, 201);
  assert.equal((await owner('POST', '/api/admin/users',
    { username: 'sam', password: 'pw-sam', role: 'SCANNER' })).status, 201);
  assert.equal((await owner('POST', '/api/admin/users',
    { username: 'out', password: 'pw-out', role: 'SCANNER' })).status, 201);

  const users = (await owner('GET', '/api/admin/users')).data;
  const eva = users.find(u => u.username === 'eva');
  const sam = users.find(u => u.username === 'sam');
  assert.equal((await owner('POST', `/api/admin/events/${eventId}/assignments`, { userId: eva.id })).status, 201);
  assert.equal((await owner('POST', `/api/admin/events/${eventId}/assignments`, { userId: sam.id })).status, 201);
});

test('non-owner cannot use owner endpoints', async () => {
  await admin('POST', '/api/login', { username: 'eva', password: 'pw-eva' });
  await scanner('POST', '/api/login', { username: 'sam', password: 'pw-sam' });
  await outsider('POST', '/api/login', { username: 'out', password: 'pw-out' });
  assert.equal((await admin('POST', '/api/admin/events', { name: 'x' })).status, 403);
  assert.equal((await scanner('GET', '/api/admin/users')).status, 403);
});

test('event admin creates sections and tickets', async () => {
  const sec = await admin('POST', `/api/events/${eventId}/sections`, { name: 'Audio Video' });
  assert.equal(sec.status, 201);
  sectionId = sec.data.id;

  // scanner may not create sections
  assert.equal((await scanner('POST', `/api/events/${eventId}/sections`, { name: 'Nope' })).status, 403);

  const gen = await admin('POST', `/api/sections/${sectionId}/tickets`, { count: 5 });
  assert.equal(gen.status, 201);
  assert.equal(gen.data.created, 5);
  uuids = gen.data.uuids;
  assert.equal(uuids.length, 5);

  assert.equal((await admin('POST', `/api/sections/${sectionId}/tickets`, { count: 0 })).status, 400);
});

test('event admin can set the daily reset time', async () => {
  assert.equal((await admin('PATCH', `/api/events/${eventId}`, { reset_time: '25:99' })).status, 400);
  const r = await admin('PATCH', `/api/events/${eventId}`, { reset_time: '06:30' });
  assert.equal(r.status, 200);
  assert.equal(r.data.reset_time, '06:30');
  await admin('PATCH', `/api/events/${eventId}`, { reset_time: '00:00' });
});

test('excel export responds; standalone QR export is gone', async () => {
  const xlsx = await admin('GET', `/api/events/${eventId}/tickets.xlsx`);
  assert.equal(xlsx.status, 200);
  assert.ok(xlsx.headers.get('content-type').includes('spreadsheetml'));
  assert.ok(xlsx.data.byteLength > 1000);

  // QR ZIP / print were superseded by the admission card and removed
  assert.equal((await admin('GET', `/api/sections/${sectionId}/qrcodes.zip`)).status, 404);
  assert.equal((await admin('GET', `/api/sections/${sectionId}/qrcodes/print`)).status, 404);
});

test('scan flow: OK, debounce, DOUBLE, ERROR', async () => {
  const first = await scanner('POST', '/api/scan', { code: uuids[0] });
  assert.equal(first.data.status, 'OK');
  assert.equal(first.data.scan_number, 1);

  // immediate re-read by the same user → debounced, same OK repeated
  const debounced = await scanner('POST', '/api/scan', { code: uuids[0] });
  assert.equal(debounced.data.status, 'OK');
  assert.equal(debounced.data.scan_number, 1);

  // a different user scanning the same code → DOUBLE with uuid
  const dbl = await admin('POST', '/api/scan', { code: uuids[0] });
  assert.equal(dbl.data.status, 'DOUBLE');
  assert.equal(dbl.data.uuid, uuids[0]);

  const second = await scanner('POST', '/api/scan', { code: uuids[1] });
  assert.equal(second.data.scan_number, 2);

  assert.equal((await scanner('POST', '/api/scan', { code: 'not-a-uuid' })).data.status, 'ERROR');
  assert.equal((await scanner('POST', '/api/scan',
    { code: '00000000-0000-4000-8000-000000000000' })).data.status, 'ERROR');

  // unassigned user cannot scan codes of this event
  assert.equal((await outsider('POST', '/api/scan', { code: uuids[2] })).data.status, 'ERROR');
});

test('dashboard shows counts and doubles', async () => {
  const dash = await scanner('GET', `/api/events/${eventId}/dashboard`);
  assert.equal(dash.status, 200);
  assert.equal(dash.data.total_sections, 1);
  assert.equal(dash.data.total_scans_today, 2);
  const section = dash.data.sections[0];
  assert.equal(section.scans_today, 2);
  assert.equal(section.doubles_today, 1);

  const doubles = await scanner('GET', `/api/sections/${sectionId}/doubles`);
  assert.equal(doubles.data.doubles.length, 1);
  assert.equal(doubles.data.doubles[0].uuid, uuids[0]);
  assert.equal(doubles.data.doubles[0].attempts, 1);

  // unassigned user gets no dashboard
  assert.equal((await outsider('GET', `/api/events/${eventId}/dashboard`)).status, 403);
});

test('daily reset boundary: scans before the boundary do not count', async () => {
  // move yesterday's scans behind the boundary by faking their timestamps
  const boundary = resetBoundary('00:00');
  db.prepare('UPDATE scans SET scanned_at = ? WHERE ticket_uuid = ?')
    .run(boundary - 1000, uuids[0]);

  const dash = await scanner('GET', `/api/events/${eventId}/dashboard`);
  assert.equal(dash.data.total_scans_today, 1);          // only uuids[1] remains
  assert.equal(dash.data.sections[0].doubles_today, 0);  // double was "yesterday"

  // after the reset, the same code scans OK again and numbering restarts fresh
  const rescan = await admin('POST', '/api/scan', { code: uuids[0] });
  assert.equal(rescan.data.status, 'OK');
  assert.equal(rescan.data.scan_number, 2);
});

test('resetBoundary math', () => {
  const now = new Date('2026-07-21T10:00:00');
  const b1 = new Date(resetBoundary('06:30', now));
  assert.equal(b1.getDate(), 21);
  assert.equal(b1.getHours(), 6);
  const b2 = new Date(resetBoundary('18:00', now)); // reset later today → last one was yesterday
  assert.equal(b2.getDate(), 20);
  assert.equal(b2.getHours(), 18);
});

test('sections get a color, randomly assigned or customized', async () => {
  const dash = await scanner('GET', `/api/events/${eventId}/dashboard`);
  assert.match(dash.data.sections[0].color, /^#[0-9a-f]{6}$/i);

  const custom = await admin('POST', `/api/events/${eventId}/sections`,
    { name: 'Parkdienst', color: '#123abc' });
  assert.equal(custom.status, 201);
  assert.equal(custom.data.color, '#123abc');

  const patched = await admin('PATCH', `/api/sections/${custom.data.id}`, { color: '#ff8800' });
  assert.equal(patched.data.color, '#ff8800');
  assert.equal((await admin('PATCH', `/api/sections/${custom.data.id}`, { color: 'rot' })).status, 400);
  await admin('DELETE', `/api/sections/${custom.data.id}`);
});

test('subsections: tickets carry them, scan label shows "Section – Subsection"', async () => {
  const sub = await admin('POST', `/api/sections/${sectionId}/subsections`, { name: 'Innenraum Ordner' });
  assert.equal(sub.status, 201);
  assert.equal((await admin('POST', `/api/sections/${sectionId}/subsections`,
    { name: 'Innenraum Ordner' })).status, 409);

  // subsection of a foreign section is rejected
  assert.equal((await admin('POST', `/api/sections/${sectionId}/tickets`,
    { count: 1, subsection_id: 99999 })).status, 400);

  const gen = await admin('POST', `/api/sections/${sectionId}/tickets`,
    { count: 1, subsection_id: sub.data.id });
  assert.equal(gen.status, 201);

  const scan = await scanner('POST', '/api/scan', { code: gen.data.uuids[0] });
  assert.equal(scan.data.status, 'OK');
  assert.equal(scan.data.section, 'Audio Video – Innenraum Ordner');

  const tickets = (await admin('GET', `/api/sections/${sectionId}/tickets`)).data;
  assert.equal(tickets.find(t => t.uuid === gen.data.uuids[0]).subsection, 'Innenraum Ordner');

  const dash = await scanner('GET', `/api/events/${eventId}/dashboard`);
  assert.deepEqual(dash.data.sections[0].subsections.map(x => x.name), ['Innenraum Ordner']);
  assert.equal(dash.data.sections[0].subsections[0].ticket_count, 1); // one ticket generated above

  assert.equal((await admin('DELETE', `/api/subsections/${sub.data.id}`)).status, 200);
});

test('admission card is defined once per event (EVENT_ADMIN only)', async () => {
  assert.equal((await owner('GET', `/api/events/${eventId}/card`)).status, 403);

  const cfg0 = await admin('GET', `/api/events/${eventId}/card`);
  assert.equal(cfg0.status, 200);
  assert.equal(cfg0.data.event, 'Kongress 2026');
  assert.equal(cfg0.data.has_backdrop, false);
  assert.equal(cfg0.data.total_tickets, 6); // 5 (Audio Video) + 1 (subsection ticket)
  assert.match(cfg0.data.sample.color, /^#[0-9a-f]{6}$/i);

  assert.equal((await admin('PUT', `/api/events/${eventId}/card`,
    { title: 'TESSERA-AUSWEIS', text: 'Liebe Schwester, **lieber** Bruder!' })).status, 200);
  const cfg1 = await admin('GET', `/api/events/${eventId}/card`);
  assert.equal(cfg1.data.title, 'TESSERA-AUSWEIS');
  assert.equal(cfg1.data.text, 'Liebe Schwester, **lieber** Bruder!');

  // flat ticket list for bulk generation carries color + label parts
  const tickets = (await admin('GET', `/api/events/${eventId}/card/tickets`)).data;
  assert.equal(tickets.length, 6);
  assert.ok(tickets.every(t => /^#[0-9a-f]{6}$/i.test(t.color) && t.section === 'Audio Video'));

  // upload raw backdrop bytes
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const up = await fetch(base + `/api/events/${eventId}/card/backdrop`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', cookie: jars.admin }, body: png,
  });
  assert.equal(up.status, 201);
  assert.equal((await admin('GET', `/api/events/${eventId}/card`)).data.has_backdrop, true);

  // serve it back verbatim via an authenticated request
  const img = await fetch(base + `/api/events/${eventId}/card/backdrop`, { headers: { cookie: jars.admin } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  const { token } = await (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'eva', password: 'pw-eva' }),
  })).json();
  assert.equal((await fetch(base + `/api/events/${eventId}/card/backdrop`,
    { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  // a token in the query string must NOT authenticate (it would leak via logs)
  assert.equal((await fetch(base + `/api/events/${eventId}/card/backdrop?token=${token}`)).status, 401);

  // wrong mime rejected, scanner cannot edit
  assert.equal((await fetch(base + `/api/events/${eventId}/card/backdrop`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', cookie: jars.admin }, body: 'x',
  })).status, 400);
  assert.equal((await scanner('PUT', `/api/events/${eventId}/card`, { title: 'x' })).status, 403);

  // delete
  assert.equal((await admin('DELETE', `/api/events/${eventId}/card/backdrop`)).status, 200);
  assert.equal((await admin('GET', `/api/events/${eventId}/card`)).data.has_backdrop, false);
  assert.equal((await fetch(base + `/api/events/${eventId}/card/backdrop`, { headers: { cookie: jars.admin } })).status, 404);
});

test('per-folder UUID excel groups by section and subsection', async () => {
  const sec = (await admin('POST', `/api/events/${eventId}/sections`, { name: 'Excel-Test' })).data;
  const sub = (await admin('POST', `/api/sections/${sec.id}/subsections`, { name: 'Team A' })).data;
  await admin('POST', `/api/sections/${sec.id}/tickets`, { count: 2 });                        // direct
  await admin('POST', `/api/sections/${sec.id}/tickets`, { count: 3, subsection_id: sub.id }); // subsection

  const res = await admin('GET', `/api/events/${eventId}/card/xlsx`);
  assert.equal(res.status, 200);
  const direct = res.data.groups.find(g => g.section === 'Excel-Test' && !g.subsection);
  const subGrp = res.data.groups.find(g => g.section === 'Excel-Test' && g.subsection === 'Team A');
  assert.ok(direct && subGrp, 'a section-direct group and a subsection group');
  for (const g of [direct, subGrp]) {
    const buf = Buffer.from(g.base64, 'base64');
    assert.equal(buf[0], 0x50); // 'P'
    assert.equal(buf[1], 0x4b); // 'K' → xlsx is a zip container
  }
  assert.equal((await owner('GET', `/api/events/${eventId}/card/xlsx`)).status, 403);

  await admin('DELETE', `/api/sections/${sec.id}`); // cleanup, cascades tickets + subsection
});

test('sections, UUIDs and cards are EVENT_ADMIN-only', async () => {
  assert.equal((await owner('POST', `/api/events/${eventId}/sections`, { name: 'X' })).status, 403);
  assert.equal((await owner('POST', `/api/sections/${sectionId}/tickets`, { count: 1 })).status, 403);
  assert.equal((await owner('GET', `/api/events/${eventId}/card`)).status, 403);
  assert.equal((await owner('GET', `/api/events/${eventId}/tickets.xlsx`)).status, 403);
  assert.equal((await owner('PATCH', `/api/events/${eventId}`, { reset_time: '05:00' })).status, 403);
});

test('owner cannot scan or view dashboards', async () => {
  assert.equal((await owner('GET', `/api/events/${eventId}/dashboard`)).status, 403);
  assert.equal((await owner('GET', `/api/sections/${sectionId}/doubles`)).status, 403);
  assert.equal((await owner('POST', '/api/scan', { code: uuids[3] })).status, 403);
});

test('owner creates an account directly inside an event', async () => {
  const r = await owner('POST', `/api/admin/events/${eventId}/users`,
    { username: 'gate1', password: 'pw-gate1', role: 'SCANNER' });
  assert.equal(r.status, 201);

  const gate = client('gate1');
  await gate('POST', '/api/login', { username: 'gate1', password: 'pw-gate1' });
  const me = await gate('GET', '/api/me');
  assert.deepEqual(me.data.events.map(e => e.id), [eventId]);
  // assigned in the same step → may scan and see the dashboard immediately
  assert.equal((await gate('GET', `/api/events/${eventId}/dashboard`)).status, 200);

  // duplicate username rolls back cleanly
  assert.equal((await owner('POST', `/api/admin/events/${eventId}/users`,
    { username: 'gate1', password: 'x', role: 'SCANNER' })).status, 409);
});

test('bearer token authenticates the account switcher and downloads', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'eva', password: 'pw-eva' }),
  });
  const { token } = await res.json();
  assert.ok(token);

  const me = await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, 'eva');

  const xlsx = await fetch(base + `/api/events/${eventId}/tickets.xlsx`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(xlsx.status, 200);

  // the same token in the query string must not authenticate
  const leaked = await fetch(base + `/api/events/${eventId}/tickets.xlsx?token=${token}`);
  assert.equal(leaked.status, 401);
});

test('unauthenticated requests are rejected', async () => {
  const anon = client('anon');
  assert.equal((await anon('GET', `/api/events/${eventId}/dashboard`)).status, 401);
  assert.equal((await anon('POST', '/api/scan', { code: uuids[0] })).status, 401);
});

test('repeated failed logins are rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'brute-victim', password: 'nope' }),
    });
    if (r.status === 429) { limited = true; assert.ok(r.headers.get('retry-after')); break; }
    assert.equal(r.status, 401);
  }
  assert.ok(limited, 'expected a 429 after repeated failed logins');
});
