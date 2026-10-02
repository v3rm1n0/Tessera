// Helpers for ticket codes (UUIDs) shared by the scan and ticket routes.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical lower-case UUID for a value that is one (case and surrounding spaces ignored), else null. */
export function normalizeUuid(value) {
  const code = String(value ?? '').trim().toLowerCase();
  return UUID_RE.test(code) ? code : null;
}

/** Shortest start of a code (in hex digits) that a person may type instead of the whole uuid. */
export const MIN_PREFIX_DIGITS = 12;

/**
 * Reads what somebody typed or scanned: a whole uuid ({ kind: 'full' }) or the first
 * MIN_PREFIX_DIGITS or more hex digits of one ({ kind: 'prefix' }, in dashed form so it can be
 * matched with LIKE). Case, spaces and dashes are ignored; anything else is null.
 */
export function parseCodeInput(value) {
  if (typeof value !== 'string') return null;
  const digits = value.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]+$/.test(digits) || digits.length < MIN_PREFIX_DIGITS || digits.length > 32) return null;
  const dashed = [digits.slice(0, 8), digits.slice(8, 12), digits.slice(12, 16), digits.slice(16, 20), digits.slice(20)]
    .filter(Boolean).join('-');
  return digits.length === 32 ? { kind: 'full', uuid: dashed } : { kind: 'prefix', prefix: dashed };
}
