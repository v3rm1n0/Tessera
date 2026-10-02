import { Router } from 'express';
import { db, resetBoundary } from '../db.js';
import { requireRole, requireEventAccess, canAccessEvent } from '../auth.js';
import { audit } from '../audit.js';
import { normalizeUuid } from '../codes.js';
import { HttpError } from '../errors.js';

/** Code management for event admins: search, holder names, revoking. */
export const ticketsRouter = Router();
const manage = requireRole('EVENT_ADMIN');

export const MAX_HOLDER = 100;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const ITEM_COLUMNS = `
  t.uuid, t.section_id, s.name AS section, s.color, t.subsection_id, sub.name AS subsection,
  t.holder, t.revoked_at, t.created_at`;
const ITEM_FROM = `
  FROM tickets t
  JOIN sections s ON s.id = t.section_id
  LEFT JOIN subsections sub ON sub.id = t.subsection_id`;

/** Builds the WHERE clause of a code search from the query string. */
function searchFilters(req) {
  const where = ['s.event_id = ?'];
  const params = [req.event.id];

  const section = Number(req.query.section);
  if (Number.isInteger(section) && section > 0) {
    where.push('t.section_id = ?');
    params.push(section);
  }
  if (req.query.subsection === 'none') {
    where.push('t.subsection_id IS NULL');
  } else {
    const subsection = Number(req.query.subsection);
    if (Number.isInteger(subsection) && subsection > 0) {
      where.push('t.subsection_id = ?');
      params.push(subsection);
    }
  }
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; // % and _ in the search text are literal
    where.push("(t.uuid LIKE ? ESCAPE '\\' OR lower(t.holder) LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (req.query.status === 'revoked') where.push('t.revoked_at IS NOT NULL');
  else if (req.query.status === 'active') where.push('t.revoked_at IS NULL');
  return { where: where.join(' AND '), params };
}

ticketsRouter.get('/events/:eventId/tickets', manage, requireEventAccess, (req, res) => {
  const { where, params } = searchFilters(req);
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || DEFAULT_PAGE, 1), MAX_PAGE);
  const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS n ${ITEM_FROM} WHERE ${where}`).get(...params).n;
  const since = resetBoundary(req.event.reset_time, undefined, req.event.timezone);
  const rows = db.prepare(`
    SELECT ${ITEM_COLUMNS},
           EXISTS (SELECT 1 FROM scans sc WHERE sc.ticket_uuid = t.uuid AND sc.result = 'OK'
                   AND sc.voided_at IS NULL AND sc.scanned_at >= ?) AS scanned_today
    ${ITEM_FROM} WHERE ${where}
    ORDER BY s.name, sub.name, t.created_at, t.uuid LIMIT ? OFFSET ?
  `).all(since, ...params, limit, offset);
  res.json({ total, items: rows.map(row => ({ ...row, scanned_today: row.scanned_today === 1 })) });
});

ticketsRouter.patch('/tickets/:uuid', manage, (req, res) => {
  const uuid = normalizeUuid(req.params.uuid);
  const ticket = uuid && db.prepare(`SELECT ${ITEM_COLUMNS}, s.event_id ${ITEM_FROM} WHERE t.uuid = ?`).get(uuid);
  if (!ticket) throw new HttpError(404, 'TICKET_NOT_FOUND');
  if (!canAccessEvent(req.user, ticket.event_id)) throw new HttpError(403, 'NOT_AUTHORIZED_EVENT');

  const { holder, revoked } = req.body || {};
  if (holder === undefined && revoked === undefined) throw new HttpError(400, 'NOTHING_TO_UPDATE');

  let nextHolder = ticket.holder;
  let nextRevokedAt = ticket.revoked_at;
  if (holder !== undefined) {
    if (typeof holder !== 'string') throw new HttpError(400, 'HOLDER_INVALID');
    nextHolder = holder.trim();
    if (nextHolder.length > MAX_HOLDER) throw new HttpError(400, 'HOLDER_TOO_LONG');
  }
  if (revoked !== undefined) {
    if (typeof revoked !== 'boolean') throw new HttpError(400, 'INVALID_REQUEST');
    nextRevokedAt = revoked ? (ticket.revoked_at ?? Date.now()) : null;
  }

  db.prepare('UPDATE tickets SET holder = ?, revoked_at = ? WHERE uuid = ?').run(nextHolder, nextRevokedAt, uuid);
  if ((ticket.revoked_at === null) !== (nextRevokedAt === null)) {
    audit(req, nextRevokedAt === null ? 'ticket.restore' : 'ticket.revoke', {
      eventId: ticket.event_id, target: uuid, details: { section: ticket.section },
    });
  }
  const { event_id: _eventId, ...item } = ticket;
  res.json({ ...item, holder: nextHolder, revoked_at: nextRevokedAt });
});
