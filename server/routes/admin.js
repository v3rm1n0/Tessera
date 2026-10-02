import { Router } from 'express';
import { db, hashPassword, eventColumns, getEvent } from '../db.js';
import { requireRole } from '../auth.js';
import { audit, listAudit } from '../audit.js';
import { HttpError } from '../errors.js';
import { serverTimeZone } from '../time.js';
import { requireName, requireNewAccount } from '../validate.js';

/** Owner-only administration: accounts, events, assignments. */
export const adminRouter = Router();
adminRouter.use(requireRole('OWNER'));

adminRouter.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
           json_group_array(a.event_id) FILTER (WHERE a.event_id IS NOT NULL) AS event_ids
    FROM users u LEFT JOIN event_assignments a ON a.user_id = u.id
    GROUP BY u.id ORDER BY u.username
  `).all();
  res.json(users.map(u => ({ ...u, event_ids: JSON.parse(u.event_ids) })));
});

adminRouter.post('/users', (req, res) => {
  const { username, password, role } = requireNewAccount(req.body);
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role);
    audit(req, 'user.create', { target: username, details: { role } });
    res.status(201).json({ id: Number(info.lastInsertRowid), username, role });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw new HttpError(409, 'USERNAME_TAKEN');
    }
    throw e;
  }
});

adminRouter.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'CANNOT_DELETE_SELF');
  const user = db.prepare("SELECT username FROM users WHERE id = ? AND role != 'OWNER'").get(id);
  const info = db.prepare("DELETE FROM users WHERE id = ? AND role != 'OWNER'").run(id);
  if (info.changes === 0) throw new HttpError(404, 'USER_NOT_FOUND');
  audit(req, 'user.delete', { target: user.username });
  res.json({ ok: true });
});

adminRouter.post('/events', (req, res) => {
  const name = requireName(req.body?.name);
  const timezone = serverTimeZone();
  const info = db.prepare('INSERT INTO events (name, timezone) VALUES (?, ?)').run(name, timezone);
  const id = Number(info.lastInsertRowid);
  audit(req, 'event.create', { eventId: id, target: name });
  res.status(201).json({ id, name, reset_time: '00:00', timezone });
});

adminRouter.get('/events', (req, res) => {
  res.json(db.prepare(`SELECT ${eventColumns()} FROM events ORDER BY name`).all());
});

adminRouter.patch('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(id);
  if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND');
  const name = requireName(req.body?.name);
  db.prepare('UPDATE events SET name = ? WHERE id = ?').run(name, id);
  if (name !== event.name) audit(req, 'event.rename', { eventId: id, target: name, details: { from: event.name } });
  res.json(getEvent(id));
});

adminRouter.delete('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare('SELECT name FROM events WHERE id = ?').get(id);
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(id);
  if (info.changes === 0) throw new HttpError(404, 'EVENT_NOT_FOUND');
  audit(req, 'event.delete', { eventId: id, target: event.name });
  res.json({ ok: true });
});

/** Creates an account and assigns it to the event in one step. */
adminRouter.post('/events/:id/users', (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(eventId);
  if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND');
  const { username, password, role } = requireNewAccount(req.body);
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role);
    db.prepare('INSERT INTO event_assignments (user_id, event_id) VALUES (?, ?)')
      .run(Number(info.lastInsertRowid), eventId);
    db.exec('COMMIT');
    audit(req, 'user.create', { eventId, target: username, details: { role } });
    audit(req, 'assignment.add', { eventId, target: username, details: { event: event.name } });
    res.status(201).json({ id: Number(info.lastInsertRowid), username, role });
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) {
      throw new HttpError(409, 'USERNAME_TAKEN');
    }
    throw e;
  }
});

adminRouter.post('/events/:id/assignments', (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.body?.userId);
  const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(eventId);
  const user = db.prepare('SELECT id, role, username FROM users WHERE id = ?').get(userId);
  if (!event || !user) throw new HttpError(404, 'EVENT_OR_USER_NOT_FOUND');
  if (user.role === 'OWNER') throw new HttpError(400, 'OWNER_NO_ASSIGNMENT');
  const info = db.prepare('INSERT OR IGNORE INTO event_assignments (user_id, event_id) VALUES (?, ?)')
    .run(userId, eventId);
  if (info.changes > 0) {
    audit(req, 'assignment.add', { eventId, target: user.username, details: { event: event.name } });
  }
  res.status(201).json({ ok: true });
});

adminRouter.delete('/events/:id/assignments/:userId', (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.params.userId);
  const who = db.prepare(`
    SELECT u.username, e.name AS event FROM users u, events e WHERE u.id = ? AND e.id = ?
  `).get(userId, eventId);
  const info = db.prepare('DELETE FROM event_assignments WHERE event_id = ? AND user_id = ?')
    .run(eventId, userId);
  if (info.changes > 0 && who) {
    audit(req, 'assignment.remove', { eventId, target: who.username, details: { event: who.event } });
  }
  res.json({ ok: true });
});

/** Activity log of administrative actions, newest first; page with ?before=<next_before>. */
adminRouter.get('/audit', (req, res) => {
  const before = Number(req.query.before);
  res.json(listAudit({
    limit: Number(req.query.limit),
    before: Number.isInteger(before) && before > 0 ? before : null,
  }));
});
