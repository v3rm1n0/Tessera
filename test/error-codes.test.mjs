import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { CODES } from '../server/errors.js';
import { dict } from '../public/js/i18n.js';

let app, owner, ownerId, ev, other, section, subsection, otherCode;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ownerId = (await owner('GET', '/api/me')).data.id;
  ev = await app.event(owner, 'Codes');
  other = await app.event(owner, 'Other');
  section = (await ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Sec' })).data;
  subsection = (await ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'Sub' })).data;
  const otherSection = (await other.admin('POST', `/api/events/${other.id}/sections`, { name: 'Elsewhere' })).data;
  otherCode = (await other.admin('POST', `/api/sections/${otherSection.id}/tickets`, { count: 1 })).data.uuids[0];
});

const anon = (...args) => app.as(null)(...args);

test('every route family answers with the documented status and code', async () => {
  const png = { raw: Buffer.alloc(0), headers: { 'Content-Type': 'image/png' } };
  const cases = [
    ['anonymous', () => anon('GET', `/api/events/${ev.id}/dashboard`), 401, 'NOT_SIGNED_IN'],
    ['wrong role', () => owner('GET', `/api/events/${ev.id}/dashboard`), 403, 'NOT_AUTHORIZED'],
    ['scanner managing sections', () => ev.scanner('POST', `/api/events/${ev.id}/sections`, { name: 'x' }), 403, 'NOT_AUTHORIZED'],
    ['foreign event', () => other.admin('GET', `/api/events/${ev.id}/card`), 403, 'NOT_AUTHORIZED_EVENT'],
    ['foreign section', () => other.admin('GET', `/api/sections/${section.id}/tickets`), 403, 'NOT_AUTHORIZED_EVENT'],
    ['foreign subsection', () => other.admin('DELETE', `/api/subsections/${subsection.id}`), 403, 'NOT_AUTHORIZED_EVENT'],
    ['unknown event (guard)', () => ev.admin('GET', '/api/events/99999/card'), 404, 'EVENT_NOT_FOUND'],
    ['unknown event (delete)', () => owner('DELETE', '/api/admin/events/99999'), 404, 'EVENT_NOT_FOUND'],
    ['unknown section', () => ev.admin('GET', '/api/sections/99999/tickets'), 404, 'SECTION_NOT_FOUND'],
    ['unknown subsection', () => ev.admin('DELETE', '/api/subsections/99999'), 404, 'SUBSECTION_NOT_FOUND'],
    ['unknown user', () => owner('DELETE', '/api/admin/users/99999'), 404, 'USER_NOT_FOUND'],
    ['unknown assignment', () => owner('POST', '/api/admin/events/99999/assignments', { userId: 99999 }), 404, 'EVENT_OR_USER_NOT_FOUND'],
    ['unknown event for new account', () => owner('POST', '/api/admin/events/99999/users', { username: 'zed', password: 'pw-zed-12345', role: 'SCANNER' }), 404, 'EVENT_NOT_FOUND'],
    ['assigning the owner', () => owner('POST', `/api/admin/events/${ev.id}/assignments`, { userId: ownerId }), 400, 'OWNER_NO_ASSIGNMENT'],
    ['deleting yourself', () => owner('DELETE', `/api/admin/users/${ownerId}`), 400, 'CANNOT_DELETE_SELF'],
    ['duplicate username', () => owner('POST', '/api/admin/users', { username: `admin${ev.id}`, password: 'pw-dupe-12345', role: 'SCANNER' }), 409, 'USERNAME_TAKEN'],
    ['duplicate username in event', () => owner('POST', `/api/admin/events/${ev.id}/users`, { username: `admin${ev.id}`, password: 'pw-dupe-12345', role: 'SCANNER' }), 409, 'USERNAME_TAKEN'],
    ['duplicate section', () => ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Sec' }), 409, 'SECTION_EXISTS'],
    ['duplicate subsection', () => ev.admin('POST', `/api/sections/${section.id}/subsections`, { name: 'Sub' }), 409, 'SUBSECTION_EXISTS'],
    ['bad color on create', () => ev.admin('POST', `/api/events/${ev.id}/sections`, { name: 'Colorful', color: 'red' }), 400, 'COLOR_INVALID'],
    ['bad color on patch', () => ev.admin('PATCH', `/api/sections/${section.id}`, { color: 'red' }), 400, 'COLOR_INVALID'],
    ['bad reset time', () => ev.admin('PATCH', `/api/events/${ev.id}`, { reset_time: '25:99' }), 400, 'RESET_TIME_INVALID'],
    ['bad ticket count', () => ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 0 }), 400, 'COUNT_INVALID'],
    ['subsection of another section', () => ev.admin('POST', `/api/sections/${section.id}/tickets`, { count: 1, subsection_id: 99999 }), 400, 'SUBSECTION_MISMATCH'],
    ['wrong image type', () => ev.admin('POST', `/api/events/${ev.id}/card/backdrop`, undefined, { raw: 'x', headers: { 'Content-Type': 'text/plain' } }), 400, 'IMAGE_TYPE_INVALID'],
    ['empty image', () => ev.admin('POST', `/api/events/${ev.id}/card/backdrop`, undefined, png), 400, 'IMAGE_MISSING'],
    ['missing backdrop', () => ev.admin('GET', `/api/events/${ev.id}/card/backdrop`), 404, 'NO_BACKDROP'],
    ['wrong password', () => anon('POST', '/api/login', { username: 'owner', password: 'definitely-wrong' }), 401, 'INVALID_CREDENTIALS'],
  ];
  for (const [label, run, status, code] of cases) {
    const res = await run();
    assert.equal(res.status, status, `${label}: status`);
    assert.equal(res.data.code, code, `${label}: code`);
    assert.ok(typeof res.data.error === 'string' && res.data.error.length > 0, `${label}: default text`);
  }
});

test('scan errors carry a code next to their message', async () => {
  const invalid = await ev.scanner('POST', '/api/scan', { code: 'not-a-uuid' });
  assert.equal(invalid.data.status, 'ERROR');
  assert.equal(invalid.data.code, 'INVALID_CODE');

  const unknown = await ev.scanner('POST', '/api/scan', { code: '00000000-0000-4000-8000-000000000000' });
  assert.equal(unknown.data.code, 'UNKNOWN_CODE');

  const foreign = await ev.scanner('POST', '/api/scan', { code: otherCode });
  assert.equal(foreign.data.code, 'NOT_AUTHORIZED_EVENT');
  for (const res of [invalid, unknown, foreign]) assert.ok(res.data.message);
});

test('the scan error codes are registered and translated', () => {
  for (const code of ['INVALID_CODE', 'UNKNOWN_CODE', 'NOT_AUTHORIZED_EVENT']) {
    assert.ok(CODES[code], `CODES.${code}`);
    assert.ok(dict.de[`err.${code}`] && dict.en[`err.${code}`], `translations for ${code}`);
  }
});
