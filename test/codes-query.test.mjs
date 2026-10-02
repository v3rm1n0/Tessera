import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, ticketBadge } from '../public/js/codes-query.js';

test('buildQuery drops empty values and keeps the order', () => {
  assert.equal(buildQuery({ q: 'anna', section: 3, status: '', subsection: undefined, offset: 0 }), '?q=anna&section=3&offset=0');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery({ q: '', section: null }), '');
});

test('buildQuery encodes special characters', () => {
  assert.equal(buildQuery({ q: 'Ä & b=c?' }), '?q=%C3%84+%26+b%3Dc%3F');
  assert.equal(buildQuery({ q: '100%' }), '?q=100%25');
});

test('ticketBadge: revoked beats scanned beats active', () => {
  assert.equal(ticketBadge({ revoked_at: 5, scanned_today: true }), 'revoked');
  assert.equal(ticketBadge({ revoked_at: null, scanned_today: true }), 'scanned');
  assert.equal(ticketBadge({ revoked_at: null, scanned_today: false }), 'active');
  assert.equal(ticketBadge({}), 'active');
});
