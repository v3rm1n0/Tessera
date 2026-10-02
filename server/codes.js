// Helpers for ticket codes (UUIDs) shared by the scan and ticket routes.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical lower-case UUID for a value that is one (case and surrounding spaces ignored), else null. */
export function normalizeUuid(value) {
  const code = String(value ?? '').trim().toLowerCase();
  return UUID_RE.test(code) ? code : null;
}
