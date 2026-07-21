import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, dict } from '../public/js/i18n.js';

test('de and en dictionaries have identical key sets', () => {
  const de = Object.keys(dict.de).sort();
  const en = Object.keys(dict.en).sort();
  assert.deepEqual(de, en);
});

test('translate returns the string for the language', () => {
  assert.equal(translate('en', 'nav.scan'), 'Scan');
  assert.equal(translate('de', 'nav.scan'), 'Scannen');
});

test('translate interpolates {name} params', () => {
  assert.equal(translate('en', 'account.logout', { name: 'joe' }), 'Log out (joe)');
});

test('missing key returns the key itself', () => {
  assert.equal(translate('en', 'nope.nope'), 'nope.nope');
});
