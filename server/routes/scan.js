import { Router } from 'express';
import { db, eventBoundary } from '../db.js';
import { requireRole, canAccessEvent } from '../auth.js';

export const scanRouter = Router();

/**
 * Server-side guard against accidental double reads: if the same user scanned
 * the same code with result OK within this window, the original OK response is
 * repeated instead of recording a DOUBLE.
 */
const DEBOUNCE_MS = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

scanRouter.post('/scan', requireRole('EVENT_ADMIN', 'SCANNER'), (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!UUID_RE.test(code)) {
    return res.json({ status: 'ERROR', message: 'Invalid code' });
  }

  const ticket = db.prepare(`
    SELECT t.uuid, t.section_id, s.event_id,
           CASE WHEN sub.name IS NULL THEN s.name
                ELSE s.name || ' – ' || sub.name END AS section_name
    FROM tickets t
    JOIN sections s ON s.id = t.section_id
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE t.uuid = ?
  `).get(code);
  if (!ticket) {
    return res.json({ status: 'ERROR', message: 'Unknown code' });
  }
  if (!canAccessEvent(req.user, ticket.event_id)) {
    return res.json({ status: 'ERROR', message: 'Not authorized for this event' });
  }

  const since = eventBoundary(ticket.event_id);
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = db.prepare(`
      SELECT * FROM scans
      WHERE ticket_uuid = ? AND result = 'OK' AND scanned_at >= ?
      ORDER BY scanned_at DESC LIMIT 1
    `).get(ticket.uuid, since);

    // same user re-reading the same code within the debounce window → repeat OK
    if (prev && prev.scanned_by === req.user.id && now - prev.scanned_at <= DEBOUNCE_MS) {
      db.exec('COMMIT');
      return res.json({
        status: 'OK',
        scan_number: prev.scan_number,
        uuid: ticket.uuid,
        section: ticket.section_name,
      });
    }

    if (prev) {
      db.prepare(`
        INSERT INTO scans (ticket_uuid, section_id, scanned_by, result, scanned_at)
        VALUES (?, ?, ?, 'DOUBLE', ?)
      `).run(ticket.uuid, ticket.section_id, req.user.id, now);
      db.exec('COMMIT');
      return res.json({
        status: 'DOUBLE',
        uuid: ticket.uuid,
        section: ticket.section_name,
        first_scanned_at: prev.scanned_at,
        message: `Code already scanned: ${ticket.uuid}`,
      });
    }

    const { n } = db.prepare(`
      SELECT COUNT(*) AS n FROM scans
      WHERE section_id = ? AND result = 'OK' AND scanned_at >= ?
    `).get(ticket.section_id, since);
    const scanNumber = n + 1;

    db.prepare(`
      INSERT INTO scans (ticket_uuid, section_id, scanned_by, result, scan_number, scanned_at)
      VALUES (?, ?, ?, 'OK', ?, ?)
    `).run(ticket.uuid, ticket.section_id, req.user.id, scanNumber, now);
    db.exec('COMMIT');

    return res.json({
      status: 'OK',
      scan_number: scanNumber,
      uuid: ticket.uuid,
      section: ticket.section_name,
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});
