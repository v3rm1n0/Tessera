// no 0 / O / 1 / l / I: a generated password is read out and typed by people
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A random password of `length` characters (default 16, about 93 bits). Bytes that would make
 * some characters more likely than others are skipped, so every character is equally likely.
 */
export function generatePassword(cryptoLike = globalThis.crypto, length = 16) {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const chars = [];
  const bytes = new Uint8Array(length * 2);
  while (chars.length < length) {
    cryptoLike.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit && chars.length < length) chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
    }
  }
  return chars.join('');
}
