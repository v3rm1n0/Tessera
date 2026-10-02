import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUuid, parseCodeInput, MIN_PREFIX_DIGITS } from '../server/codes.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

test('normalizeUuid accepts a full uuid in any case with surrounding spaces', () => {
  assert.equal(normalizeUuid(UUID), UUID);
  assert.equal(normalizeUuid(`  ${UUID.toUpperCase()} `), UUID);
  assert.equal(normalizeUuid('not-a-uuid'), null);
  assert.equal(normalizeUuid(UUID.slice(0, 20)), null);
  assert.equal(normalizeUuid(undefined), null);
  assert.equal(normalizeUuid(42), null);
});

test('parseCodeInput recognizes full uuids, written with or without dashes', () => {
  assert.deepEqual(parseCodeInput(UUID), { kind: 'full', uuid: UUID });
  assert.deepEqual(parseCodeInput(UUID.toUpperCase()), { kind: 'full', uuid: UUID });
  assert.deepEqual(parseCodeInput(UUID.replaceAll('-', '')), { kind: 'full', uuid: UUID });
  assert.deepEqual(parseCodeInput(`  ${UUID}\n`), { kind: 'full', uuid: UUID });
});

test('parseCodeInput turns the start of a uuid into a dashed prefix', () => {
  assert.equal(MIN_PREFIX_DIGITS, 12);
  assert.deepEqual(parseCodeInput('550E8400-E29B'), { kind: 'prefix', prefix: '550e8400-e29b' });
  assert.deepEqual(parseCodeInput('550e8400e29b'), { kind: 'prefix', prefix: '550e8400-e29b' });
  assert.deepEqual(parseCodeInput('550e8400 e29b'), { kind: 'prefix', prefix: '550e8400-e29b' });
  assert.deepEqual(parseCodeInput('550e8400-e29b-41'), { kind: 'prefix', prefix: '550e8400-e29b-41' });
  assert.deepEqual(parseCodeInput('550e8400-e29b-41d4-a716-4466'), { kind: 'prefix', prefix: '550e8400-e29b-41d4-a716-4466' });
});

test('parseCodeInput rejects input that is too short, not hexadecimal or too long', () => {
  for (const bad of ['', '   ', '550e8400-e2', '550e8400e29', 'zzzzzzzzzzzzzz', '550e8400-e29b-xyz', `${UUID}0`, undefined, null, 12345678901234]) {
    assert.equal(parseCodeInput(bad), null, JSON.stringify(bad));
  }
});
