import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barHeights } from '../public/js/bars.js';

test('the largest value gets the full height, the rest scale linearly', () => {
  assert.deepEqual(barHeights([0, 2, 4], 100), [0, 50, 100]);
  assert.deepEqual(barHeights([5, 10], 40), [20, 40]);
});

test('zeros stay empty, tiny non-zero values stay visible', () => {
  assert.deepEqual(barHeights([0, 0, 0], 60), [0, 0, 0]);
  assert.deepEqual(barHeights([1, 1000], 100), [2, 100]);
});

test('a single value fills the height and an empty list stays empty', () => {
  assert.deepEqual(barHeights([7], 64), [64]);
  assert.deepEqual(barHeights([], 64), []);
});

test('heights are whole pixels', () => {
  const heights = barHeights([1, 2, 3], 10);
  assert.ok(heights.every(Number.isInteger));
  assert.deepEqual(heights, [3, 7, 10]);
});
