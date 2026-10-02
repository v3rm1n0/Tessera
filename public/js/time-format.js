/**
 * Formats an instant on the wall clock of an IANA time zone. An unknown or missing zone falls back
 * to the browser's own zone instead of throwing.
 */
export function formatInZone(ms, options, timeZone, locale) {
  try {
    return new Date(ms).toLocaleString(locale, timeZone ? { ...options, timeZone } : options);
  } catch {
    return new Date(ms).toLocaleString(locale, options);
  }
}
