import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, OWNER_PASSWORD } from './helpers.mjs';
import { CODES } from '../server/errors.js';

let app, owner, ev;

before(async () => {
  app = await startTestApp();
  owner = await app.login('owner', OWNER_PASSWORD);
  ev = await app.event(owner, 'Validation');
});

const anon = () => app.as(null);
const goodAccount = { username: 'newbie', password: 'long-enough-pw', role: 'SCANNER' };

test('login rejects credentials that are not strings', async () => {
  for (const body of [
    { username: 'owner', password: 12345 },
    { username: { a: 1 }, password: 'x' },
    { username: 'owner' },
    {},
  ]) {
    const res = await anon()('POST', '/api/login', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.data.code, 'CREDENTIALS_REQUIRED');
  }
});

test('account creation validates the username', async () => {
  for (const username of ['   ', '', 'x'.repeat(65), 'bad\u0007name', 12345, null]) {
    const res = await owner('POST', '/api/admin/users', { ...goodAccount, username });
    assert.equal(res.status, 400, JSON.stringify(username));
    assert.equal(res.data.code, 'USERNAME_INVALID');
  }
});

test('account creation enforces the password policy', async () => {
  const short = await owner('POST', '/api/admin/users', { ...goodAccount, password: 'a'.repeat(7) });
  assert.equal(short.status, 400);
  assert.equal(short.data.code, 'PASSWORD_TOO_SHORT');

  const long = await owner('POST', '/api/admin/users', { ...goodAccount, password: 'a'.repeat(257) });
  assert.equal(long.status, 400);
  assert.equal(long.data.code, 'PASSWORD_TOO_LONG');

  for (const password of [undefined, 12345345, null]) {
    const res = await owner('POST', '/api/admin/users', { ...goodAccount, password });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'CREDENTIALS_REQUIRED');
  }

  const edge = await owner('POST', '/api/admin/users', { ...goodAccount, username: 'edge8', password: 'a'.repeat(8) });
  assert.equal(edge.status, 201, 'exactly the minimum length is accepted');
});

test('the role must be one of the assignable roles', async () => {
  for (const role of ['OWNER', 'ROOT', undefined, 5]) {
    const res = await owner('POST', '/api/admin/users', { ...goodAccount, username: 'role-check', role });
    assert.equal(res.status, 400, String(role));
    assert.equal(res.data.code, 'ROLE_INVALID');
  }
});

test('a valid account is created with a trimmed username', async () => {
  const res = await owner('POST', '/api/admin/users', { ...goodAccount, username: '  neo  ' });
  assert.equal(res.status, 201);
  assert.equal(res.data.username, 'neo');
  assert.equal((await app.login('neo', goodAccount.password)).token.length > 10, true);
});

test('accounts created inside an event follow the same rules', async () => {
  const path = `/api/admin/events/${ev.id}/users`;
  const badName = await owner('POST', path, { ...goodAccount, username: '   ' });
  assert.equal(badName.data.code, 'USERNAME_INVALID');
  const badPw = await owner('POST', path, { ...goodAccount, username: 'inside', password: 'short' });
  assert.equal(badPw.data.code, 'PASSWORD_TOO_SHORT');
  const numeric = await owner('POST', path, { ...goodAccount, username: 777 });
  assert.equal(numeric.status, 400);
  const ok = await owner('POST', path, { ...goodAccount, username: 'inside' });
  assert.equal(ok.status, 201);
});

test('event names must be non-empty strings of reasonable length', async () => {
  for (const name of [12345, '   ', '', undefined, null]) {
    const res = await owner('POST', '/api/admin/events', { name });
    assert.equal(res.status, 400, JSON.stringify(name));
    assert.equal(res.data.code, 'NAME_REQUIRED');
  }
  const long = await owner('POST', '/api/admin/events', { name: 'n'.repeat(101) });
  assert.equal(long.status, 400);
  assert.equal(long.data.code, 'NAME_TOO_LONG');
  const ok = await owner('POST', '/api/admin/events', { name: '  Spaced  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.name, 'Spaced');
});

test('section and subsection names are validated too', async () => {
  const sectionsPath = `/api/events/${ev.id}/sections`;
  for (const name of [12345, '   ', undefined]) {
    const res = await ev.admin('POST', sectionsPath, { name });
    assert.equal(res.status, 400, JSON.stringify(name));
    assert.equal(res.data.code, 'NAME_REQUIRED');
  }
  assert.equal((await ev.admin('POST', sectionsPath, { name: 'n'.repeat(101) })).data.code, 'NAME_TOO_LONG');
  const section = await ev.admin('POST', sectionsPath, { name: '  Parking  ' });
  assert.equal(section.status, 201);
  assert.equal(section.data.name, 'Parking');

  const subPath = `/api/sections/${section.data.id}/subsections`;
  assert.equal((await ev.admin('POST', subPath, { name: 42 })).data.code, 'NAME_REQUIRED');
  assert.equal((await ev.admin('POST', subPath, { name: 'n'.repeat(101) })).data.code, 'NAME_TOO_LONG');
  assert.equal((await ev.admin('POST', subPath, { name: 'North' })).status, 201);
});

test('the documented password limits match the error messages', async () => {
  const { MIN_PASSWORD, MAX_PASSWORD } = await import('../server/validate.js');
  assert.ok(CODES.PASSWORD_TOO_SHORT.includes(String(MIN_PASSWORD)));
  assert.ok(CODES.PASSWORD_TOO_LONG.includes(String(MAX_PASSWORD)));
});
