import { Router } from 'express';
import { db, eventBoundary } from '../db.js';
import { requireRole, canAccessEvent } from '../auth.js';
import { audit } from '../audit.js';
import { CODES, HttpError } from '../errors.js';
import { UUID_RE } from '../codes.js';

export const scanRouter = Router();

// same user re-scanning the same code within this window repeats the OK response instead of recording a DOUBLE
const DEBOUNCE_MS = 5000;

// a scanner may take back their own scan this long after making it (event admins may always)
export const UNDO_WINDOW_MS = 60_000;

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
    // voided scans are as good as never made
    const prev = db.prepare(`
      SELECT * FROM scans
      WHERE ticket_uuid = ? AND result = 'OK' AND voided_at IS NULL AND scanned_at >= ?
      ORDER BY scanned_at DESC LIMIT 1
    `).get(ticket.uuid, since);

    if (prev && prev.scanned_by === req.user.id && now - prev.scanned_at <= DEBOUNCE_MS) {
      db.exec('COMMIT');
      return res.json({
        status: 'OK',
        scan_id: prev.id,
        scan_number: prev.scan_number,
        uuid: ticket.uuid,
        section: ticket.section_name,
        ...holderField(ticket),
      });
    }

    if (prev) {
      const info = db.prepare(`
        INSERT INTO scans (ticket_uuid, section_id, scanned_by, result, scanned_at)
        VALUES (?, ?, ?, 'DOUBLE', ?)
      `).run(ticket.uuid, ticket.section_id, req.user.id, now);
      db.exec('COMMIT');
      const first = prev.scanned_by == null ? null
        : db.prepare('SELECT username FROM users WHERE id = ?').get(prev.scanned_by);
      return res.json({
        status: 'DOUBLE',
        scan_id: Number(info.lastInsertRowid),
        uuid: ticket.uuid,
        section: ticket.section_name,
        first_scanned_at: prev.scanned_at,
        first_scanned_by: first?.username ?? null,
        ...holderField(ticket),
        message: `Code already scanned: ${ticket.uuid}`,
      });
    }

    // numbers come from the highest one handed out today (voided scans included), so a number
    // taken back by an undo is never given to somebody else
    const { n } = db.prepare(`
      SELECT COALESCE(MAX(scan_number), 0) AS n FROM scans
      WHERE section_id = ? AND result = 'OK' AND scanned_at >= ?
    `).get(ticket.section_id, since);
    const scanNumber = n + 1;

    const info = db.prepare(`
      INSERT INTO scans (ticket_uuid, section_id, scanned_by, result, scan_number, scanned_at)
      VALUES (?, ?, ?, 'OK', ?, ?)
    `).run(ticket.uuid, ticket.section_id, req.user.id, scanNumber, now);
    db.exec('COMMIT');

    return res.json({
      status: 'OK',
      scan_id: Number(info.lastInsertRowid),
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

/** Takes back a scan (soft delete: the row stays, it just stops counting). */
scanRouter.post('/scans/:id/void', requireRole('EVENT_ADMIN', 'SCANNER'), (req, res) => {
  const id = Number(req.params.id);
  const scan = db.prepare(`
    SELECT sc.id, sc.ticket_uuid, sc.result, sc.scanned_by, sc.scanned_at, sc.voided_at,
           s.event_id, s.name AS section
    FROM scans sc JOIN sections s ON s.id = sc.section_id
    WHERE sc.id = ?
  `).get(id);
  if (!scan) throw new HttpError(404, 'SCAN_NOT_FOUND');
  if (!canAccessEvent(req.user, scan.event_id)) throw new HttpError(403, 'NOT_AUTHORIZED_EVENT');
  if (req.user.role !== 'EVENT_ADMIN') {
    if (scan.scanned_by !== req.user.id) throw new HttpError(403, 'NOT_AUTHORIZED');
    if (Date.now() - scan.scanned_at > UNDO_WINDOW_MS) throw new HttpError(403, 'UNDO_EXPIRED');
  }
  if (scan.voided_at) throw new HttpError(409, 'ALREADY_VOIDED');

  db.prepare('UPDATE scans SET voided_at = ?, voided_by = ? WHERE id = ?').run(Date.now(), req.user.id, id);
  audit(req, 'scan.void', {
    eventId: scan.event_id, target: scan.ticket_uuid, details: { result: scan.result, section: scan.section },
  });
  res.json({ ok: true });
});
