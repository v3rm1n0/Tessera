import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, PASSWORD_ALPHABET } from '../public/js/password.js';

/** A crypto stand-in that hands out the given bytes in order, cycling. */
function fakeCrypto(bytes) {
  let i = 0;
  return { getRandomValues(buffer) { for (let k = 0; k < buffer.length; k++) buffer[k] = bytes[i++ % bytes.length]; return buffer; } };
}

test('the alphabet has no look-alike characters', () => {
  assert.equal(PASSWORD_ALPHABET.length, 57);
  assert.equal(new Set(PASSWORD_ALPHABET).size, 57);
  for (const ch of '0O1lI') assert.ok(!PASSWORD_ALPHABET.includes(ch), `${ch} must not be used`);
});

test('a password has the requested length and only uses the alphabet', () => {
  assert.equal(generatePassword(globalThis.crypto).length, 16);
  const long = generatePassword(globalThis.crypto, 40);
  assert.equal(long.length, 40);
  assert.ok([...long].every(ch => PASSWORD_ALPHABET.includes(ch)));
  assert.notEqual(generatePassword(globalThis.crypto), generatePassword(globalThis.crypto));
});

test('bytes map to alphabet positions in order', () => {
  const bytes = Array.from({ length: 16 }, (_, i) => i);
  assert.equal(generatePassword(fakeCrypto(bytes), 16), PASSWORD_ALPHABET.slice(0, 16));
});

test('bytes that would bias the result are skipped (rejection sampling)', () => {
  // 256 % 57 = 28, so bytes 228..255 are rejected; 227 is the last usable one (-> position 56)
  const result = generatePassword(fakeCrypto([255, 228, 227, 0, 254, 1]), 3);
  assert.equal(result, `${PASSWORD_ALPHABET[56]}${PASSWORD_ALPHABET[0]}${PASSWORD_ALPHABET[1]}`);
});

test('every character of the alphabet comes up about equally often', () => {
  const counts = new Map([...PASSWORD_ALPHABET].map(ch => [ch, 0]));
  for (let i = 0; i < 1250; i++) for (const ch of generatePassword(globalThis.crypto, 16)) counts.set(ch, counts.get(ch) + 1);
  const expected = (1250 * 16) / PASSWORD_ALPHABET.length; // about 351
  for (const [ch, n] of counts) {
    assert.ok(n > expected * 0.65 && n < expected * 1.35, `${ch} appeared ${n} times (expected about ${Math.round(expected)})`);
  }
});
