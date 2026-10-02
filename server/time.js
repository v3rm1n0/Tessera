// Time-zone aware helpers for the daily reset: "today" means "since the last reset time shown on
// the wall clock of the event's zone". Zone '' keeps the legacy behavior (the server's own zone).

const MAX_DAYS = 3660; // safety cap for dayBoundaries()
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The canonical IANA id for a zone name (case-insensitive, aliases resolved), or null when unknown. */
export function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTimeZone(value) {
  return canonicalTimeZone(value) !== null;
}

/** The zone the server process runs in (honors the TZ environment variable). */
export function serverTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Wall-clock fields of an instant as seen in a zone. */
export function zonedParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Offset of the zone from UTC at an instant, in ms (east of UTC is positive). */
function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(new Date(ms), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock of the zone shows the given date and time. A time that does
 * not exist (clocks jumped over it) resolves to the same wall time after the gap; a time that
 * happens twice (clocks fell back) resolves to its later occurrence.
 */
export function wallToInstant(timeZone, year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const guess = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(guess, timeZone);
}

function localBoundary(hour, minute, now) {
  const boundary = new Date(now);
  boundary.setHours(hour, minute, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

/**
 * Timestamp (ms) of the most recent daily reset: "today" = scans with scanned_at >= this, so
 * counts reset at the configured time without a cron job. `timeZone` is an IANA id; '' or
 * undefined means the server's own zone.
 */
export function resetBoundary(resetTime, now = new Date(), timeZone = '') {
  const [hour, minute] = resetTime.split(':').map(Number);
  if (!timeZone) return localBoundary(hour, minute, now);
  const p = zonedParts(now, timeZone);
  let boundary = wallToInstant(timeZone, p.year, p.month, p.day, hour, minute);
  if (boundary > now.getTime()) {
    const yesterday = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
    boundary = wallToInstant(
      timeZone, yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate(), hour, minute);
  }
  return boundary;
}

function nextBoundary(cursor, hour, minute, timeZone) {
  if (!timeZone) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
    return next.getTime();
  }
  const p = zonedParts(new Date(cursor), timeZone);
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return wallToInstant(
    timeZone, tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute);
}

/**
 * Start instants of the event days that cover [fromMs, toMs], ascending: the first is the boundary
 * at or before fromMs, the last is the latest one that is not after toMs. Days around DST changes
 * are 23 or 25 hours long. An inverted range yields [].
 */
export function dayBoundaries(resetTime, timeZone, fromMs, toMs) {
  if (toMs < fromMs) return [];
  const [hour, minute] = resetTime.split(':').map(Number);
  let cursor = resetBoundary(resetTime, new Date(fromMs), timeZone);
  const out = [cursor];
  for (let i = 0; i < MAX_DAYS; i++) {
    const next = nextBoundary(cursor, hour, minute, timeZone);
    if (next <= cursor || next > toMs) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * A Date whose UTC fields show the wall-clock time of `ms` in the zone ('' = the server's own
 * zone). Spreadsheet cells carry no zone, so exports write these to display local times.
 */
export function wallClockDate(ms, timeZone = '') {
  if (!timeZone) {
    const d = new Date(ms);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
  }
  const p = zonedParts(new Date(ms), timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}
