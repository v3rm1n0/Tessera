import { formatInZone } from './time-format.js';

const CLOCK = { hour: '2-digit', minute: '2-digit', second: '2-digit' };

/** How long a scanner may take back their own scan (the server's UNDO_WINDOW_MS). */
export const UNDO_WINDOW_MS = 60_000;

/**
 * Whether the undo offer for `lastScan` ({ scanId, at }, `at` = when the request was sent) is still
 * open at `now`. It closes a hair before the server's window does, never after.
 */
export function undoActive(lastScan, now) {
  return Boolean(lastScan?.scanId) && now - lastScan.at < UNDO_WINDOW_MS;
}

const summarize = (...bits) => bits.filter(Boolean).join(' · ');

/** The error in the user's language when the server sent a known code, else its raw text. */
function errorText(result, { t, hasKey }) {
  return result.code && hasKey(`err.${result.code}`) ? t(`err.${result.code}`) : (result.message || t('scan.invalid'));
}

/**
 * Turns a scan response (or the client-side `{ status: 'OFFLINE' }` marker) into what the result
 * overlay shows: `kind` picks colour and haptics, `scanId` is what undoing needs (accepted scans and
 * duplicates only) and `summary` names such a scan for the undo bar, `parts` are the lines top to
 * bottom with the CSS class of each. Empty values are left out, so a ticket without a holder simply
 * has no holder line.
 */
export function describeResult(result, { t, hasKey, locale, timeZone }) {
  const r = result || {};
  const parts = [];
  const add = (cls, text) => { if (text) parts.push({ cls, text }); };

  switch (r.status) {
    case 'OK':
      add('big', t('scan.ok'));
      add('num', String(r.scan_number));
      add('holder', r.holder);
      add('detail', r.section);
      return { kind: 'ok', scanId: r.scan_id, summary: summarize(`#${r.scan_number}`, r.holder, r.section), parts };

    case 'DOUBLE': {
      add('big', t('scan.double'));
      add('holder', r.holder);
      add('detail', r.section);
      add('detail', t('scan.alreadyScanned'));
      add('uuid', r.uuid);
      if (r.first_scanned_at) {
        const time = formatInZone(r.first_scanned_at, CLOCK, timeZone, locale);
        add('detail', r.first_scanned_by
          ? t('scan.firstScanBy', { time, name: r.first_scanned_by })
          : t('scan.firstScan', { time }));
      }
      return { kind: 'double', scanId: r.scan_id, summary: summarize(t('scan.duplicate'), r.holder, r.section), parts };
    }

    case 'REVOKED':
      add('big', t('scan.revoked'));
      add('holder', r.holder);
      add('detail', r.section);
      add('detail', t('err.CODE_REVOKED'));
      add('uuid', r.uuid);
      return { kind: 'revoked', parts };

    case 'OFFLINE':
      add('big', t('scan.offline'));
      add('detail', t('scan.offlineHint'));
      return { kind: 'offline', parts };

    default: // ERROR, and anything the client does not know: shown, never a crash
      add('big', t('scan.errorTitle'));
      add('detail', errorText(r, { t, hasKey }));
      return { kind: 'error', parts };
  }
}
