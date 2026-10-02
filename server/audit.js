import { db } from './db.js';

/**
 * Records an administrative action. `actor` is taken from req.user; the username is stored next
 * to the id so the entry stays readable after the account is deleted. event_id has no foreign key
 * on purpose: entries about a deleted event must survive it.
 */
export function audit(req, action, { eventId = null, target = '', details = null } = {}) {
  db.prepare(`
    INSERT INTO audit_log (user_id, username, event_id, action, target, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.user?.id ?? null, req.user?.username ?? '', eventId,
    action, String(target).slice(0, 200), details ? JSON.stringify(details) : '',
  );
}

/** Newest first. `before` is an entry id; the result's `next_before` continues the listing (null at the end). */
export function listAudit({ limit = 50, before = null, eventId = null } = {}) {
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT id, at, username, event_id, action, target, details FROM audit_log
    WHERE (? IS NULL OR id < ?) AND (? IS NULL OR event_id = ?)
    ORDER BY id DESC LIMIT ?
  `).all(before, before, eventId, eventId, size + 1);
  const items = rows.slice(0, size).map(row => ({
    ...row, details: row.details ? JSON.parse(row.details) : null,
  }));
  return { items, next_before: rows.length > size ? items[items.length - 1].id : null };
}
