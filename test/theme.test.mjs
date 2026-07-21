import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme } from '../public/js/theme.js';

test('explicit preference wins over system signal', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('system follows the OS prefers-light signal', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
});

test('unknown preference falls back to system behavior', () => {
  assert.equal(resolveTheme('bogus', true), 'light');
  assert.equal(resolveTheme(undefined, false), 'dark');
});
