import './env.mjs';
import { test, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.mjs';
import { CODES, HttpError, errorHandler } from '../server/errors.js';
import { dict } from '../public/js/i18n.js';

function fakeRes() {
  return {
    headersSent: false, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('every error code has a German and an English message', () => {
  for (const code of Object.keys(CODES)) {
    assert.ok(dict.de[`err.${code}`], `de err.${code}`);
    assert.ok(dict.en[`err.${code}`], `en err.${code}`);
  }
});

test('HttpError defaults its message from CODES and accepts an override', () => {
  const a = new HttpError(400, 'INVALID_JSON');
  assert.equal(a.status, 400);
  assert.equal(a.code, 'INVALID_JSON');
  assert.equal(a.message, CODES.INVALID_JSON);
  assert.equal(new HttpError(409, 'INVALID_REQUEST', 'custom').message, 'custom');
});

test('errorHandler answers an HttpError with its status, message and code', () => {
  const res = fakeRes();
  errorHandler(new HttpError(409, 'INVALID_REQUEST', 'nope'), {}, res, () => assert.fail('next called'));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'nope', code: 'INVALID_REQUEST' });
});

test('errorHandler keeps 4xx statuses from other libraries', () => {
  const tooLarge = fakeRes();
  errorHandler(Object.assign(new Error('x'), { status: 413, type: 'entity.too.large' }), {}, tooLarge, () => {});
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.code, 'PAYLOAD_TOO_LARGE');

  const teapot = fakeRes();
  errorHandler(Object.assign(new Error('x'), { statusCode: 418 }), {}, teapot, () => {});
  assert.equal(teapot.statusCode, 418);
  assert.equal(teapot.body.code, 'INVALID_REQUEST');
});

test('errorHandler logs unexpected errors and hides the details', () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const res = fakeRes();
    errorHandler(new Error('database exploded'), {}, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error', code: 'INTERNAL' });
    assert.equal(log.mock.callCount(), 1);
  } finally {
    log.mock.restore();
  }
});

test('errorHandler hands over when the response has already started', () => {
  const res = fakeRes();
  res.headersSent = true;
  const err = new Error('late');
  let forwarded;
  errorHandler(err, {}, res, e => { forwarded = e; });
  assert.equal(forwarded, err);
  assert.equal(res.body, null);
});

let app;
before(async () => { app = await startTestApp(); });

test('malformed JSON is a 400, not a 500', async () => {
  const res = await app.as(null)('POST', '/api/login', undefined, {
    raw: '{bad json', headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'INVALID_JSON');
});

test('a body over the 1 MB limit is a 413, not a 500', async () => {
  const res = await app.as(null)('POST', '/api/login', undefined, {
    raw: JSON.stringify({ username: 'a', password: 'x'.repeat(1_200_000) }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 413);
  assert.equal(res.data.code, 'PAYLOAD_TOO_LARGE');
});
