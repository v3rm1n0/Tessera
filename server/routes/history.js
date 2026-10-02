import { Router } from 'express';
import { db } from '../db.js';
import { requireRole, requireEventAccess } from '../auth.js';
import { dayBoundaries } from '../time.js';

/** Per-day history of an event for event admins and scanners. */
export const historyRouter = Router();
const eventRoles = requireRole('EVENT_ADMIN', 'SCANNER');

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const MAX_HISTORY_DAYS = 62;

/**
 * Event days run from one reset time to the next (in the event's time zone), newest first. Each
 * day carries its totals, the activity per section and the number of OK scans per hour (counted
 * from the start of the day, so days around daylight-saving changes have 23 or 25 slots).
 * Voided scans never count.
 */
historyRouter.get('/events/:eventId/history', eventRoles, requireEventAccess, (req, res) => {
  const { id, name, reset_time: resetTime, timezone } = req.event;
  const event = { id, name, reset_time: resetTime, timezone };

  const { first } = db.prepare(`
    SELECT MIN(sc.scanned_at) AS first FROM scans sc
    JOIN sections s ON s.id = sc.section_id
    WHERE s.event_id = ? AND sc.voided_at IS NULL
  `).get(id);
  if (first == null) return res.json({ event, days: [] });

  const now = Date.now();
  // look two days past "now" so the current day has an end instant
  const bounds = dayBoundaries(resetTime, timezone, first, now + 2 * DAY_MS);
  let windows = [];
  for (let i = 0; i + 1 < bounds.length && bounds[i] <= now; i++) windows.push([bounds[i], bounds[i + 1]]);
  if (windows.length > MAX_HISTORY_DAYS) windows = windows.slice(-MAX_HISTORY_DAYS);

  const perSection = db.prepare(`
    SELECT s.id, s.name, s.color,
           SUM(CASE WHEN sc.result = 'OK' THEN 1 ELSE 0 END) AS ok,
           COUNT(DISTINCT CASE WHEN sc.result = 'DOUBLE' THEN sc.ticket_uuid END) AS doubles
    FROM scans sc JOIN sections s ON s.id = sc.section_id
    WHERE s.event_id = ? AND sc.voided_at IS NULL AND sc.scanned_at >= ? AND sc.scanned_at < ?
    GROUP BY s.id ORDER BY s.name
  `);
  const perHour = db.prepare(`
    SELECT CAST((sc.scanned_at - ?) / ${HOUR_MS} AS INTEGER) AS hour, COUNT(*) AS n
    FROM scans sc JOIN sections s ON s.id = sc.section_id
    WHERE s.event_id = ? AND sc.result = 'OK' AND sc.voided_at IS NULL
      AND sc.scanned_at >= ? AND sc.scanned_at < ?
    GROUP BY hour
  `);

  const days = windows.map(([start, end]) => {
    const sections = perSection.all(id, start, end).map(r => ({
      id: r.id, name: r.name, color: r.color, ok: Number(r.ok), doubles: Number(r.doubles),
    }));
    const hourly = new Array(Math.round((end - start) / HOUR_MS)).fill(0);
    for (const { hour, n } of perHour.all(start, id, start, end)) {
      if (hour >= 0 && hour < hourly.length) hourly[hour] = Number(n);
    }
    return {
      start, end,
      ok: sections.reduce((sum, s) => sum + s.ok, 0),
      doubles: sections.reduce((sum, s) => sum + s.doubles, 0),
      sections, hourly,
    };
  });
  res.json({ event, days: days.reverse() });
});
