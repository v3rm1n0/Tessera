import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSheetName } from '../server/xlsx.js';

/** Runs names through uniqueSheetName with a shared `used` set, like the export does. */
function run(...raw) {
  const used = new Set(['history']);
  return raw.map(name => uniqueSheetName(name, used));
}

test('names that differ only by case get a numbered suffix', () => {
  assert.deepEqual(run('Audio', 'audio'), ['Audio', 'audio (2)']);
});

test('illegal characters become spaces and can collide', () => {
  assert.deepEqual(run('Gate A/B', 'Gate A?B'), ['Gate A B', 'Gate A B (2)']);
});

test('long names sharing their first 31 characters stay distinct and within the limit', () => {
  const [a, b] = run(`${'x'.repeat(40)}1`, `${'x'.repeat(40)}2`);
  assert.notEqual(a.toLowerCase(), b.toLowerCase());
  assert.ok(a.length <= 31 && b.length <= 31);
});

test('the reserved name History is never used as is', () => {
  const [name] = run('History');
  assert.notEqual(name.toLowerCase(), 'history');
  assert.equal(name, 'History (2)');
});

test('leading and trailing apostrophes are stripped', () => {
  assert.deepEqual(run("'quoted'"), ['quoted']);
});

test('empty or non-string input falls back to Sheet', () => {
  assert.deepEqual(run('', '   ', '///'), ['Sheet', 'Sheet (2)', 'Sheet (3)']);
  assert.deepEqual(run(undefined, null), ['Sheet', 'Sheet (2)']);
});

test('the suffix never pushes a name past 31 characters', () => {
  const full = 'y'.repeat(31);
  const [a, b, c] = run(full, full, full);
  assert.equal(a, full);
  assert.ok(b.length <= 31 && c.length <= 31);
  assert.equal(new Set([a, b, c].map(n => n.toLowerCase())).size, 3);
});
