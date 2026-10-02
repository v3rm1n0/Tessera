import { Router } from 'express';
import { db, eventBoundary } from '../db.js';
import { requireRole, canAccessEvent } from '../auth.js';
import { CODES } from '../errors.js';
import { UUID_RE } from '../codes.js';

export const scanRouter = Router();

// same user re-scanning the same code within this window repeats the OK response instead of recording a DOUBLE
const DEBOUNCE_MS = 5000;

/** Scan problems are 200 responses with a status the scanner UI renders; the code lets it translate them. */
const scanError = code => ({ status: 'ERROR', code, message: CODES[code] });

/** The holder's name belongs in a scan response only when there is one. */
const holderField = ticket => (ticket.holder ? { holder: ticket.holder } : {});

scanRouter.post('/scan', requireRole('EVENT_ADMIN', 'SCANNER'), (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!UUID_RE.test(code)) {
    return res.json(scanError('INVALID_CODE'));
  }

  const ticket = db.prepare(`
    SELECT t.uuid, t.section_id, t.holder, t.revoked_at, s.event_id,
           CASE WHEN sub.name IS NULL THEN s.name
                ELSE s.name || ' – ' || sub.name END AS section_name
    FROM tickets t
    JOIN sections s ON s.id = t.section_id
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE t.uuid = ?
  `).get(code);
  if (!ticket) {
    return res.json(scanError('UNKNOWN_CODE'));
  }
  if (!canAccessEvent(req.user, ticket.event_id)) {
    return res.json(scanError('NOT_AUTHORIZED_EVENT'));
  }
  if (ticket.revoked_at) {
    // a revoked code is refused outright and not recorded as a scan
    return res.json({
      status: 'REVOKED', code: 'CODE_REVOKED', message: CODES.CODE_REVOKED,
      uuid: ticket.uuid, section: ticket.section_name, ...holderField(ticket),
    });
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

    if (prev && prev.scanned_by === req.user.id && now - prev.scanned_at <= DEBOUNCE_MS) {
      db.exec('COMMIT');
      return res.json({
        status: 'OK',
        scan_number: prev.scan_number,
        uuid: ticket.uuid,
        section: ticket.section_name,
        ...holderField(ticket),
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
        ...holderField(ticket),
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
      ...holderField(ticket),
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});
