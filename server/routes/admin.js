import { Router } from 'express';
import { db, hashPassword } from '../db.js';
import { requireRole } from '../auth.js';

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
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!['EVENT_ADMIN', 'SCANNER'].includes(role)) {
    return res.status(400).json({ error: 'Role must be EVENT_ADMIN or SCANNER' });
  }
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username.trim(), hashPassword(password), role);
    res.status(201).json({ id: Number(info.lastInsertRowid), username: username.trim(), role });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    throw e;
  }
});

adminRouter.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const info = db.prepare("DELETE FROM users WHERE id = ? AND role != 'OWNER'").run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

adminRouter.post('/events', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const info = db.prepare('INSERT INTO events (name) VALUES (?)').run(name);
  res.status(201).json({ id: Number(info.lastInsertRowid), name, reset_time: '00:00' });
});

adminRouter.get('/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY name').all());
});

adminRouter.delete('/events/:id', (req, res) => {
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
});

/** Creates an account and assigns it to the event in one step. */
adminRouter.post('/events/:id/users', (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!['EVENT_ADMIN', 'SCANNER'].includes(role)) {
    return res.status(400).json({ error: 'Role must be EVENT_ADMIN or SCANNER' });
  }
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username.trim(), hashPassword(password), role);
    db.prepare('INSERT INTO event_assignments (user_id, event_id) VALUES (?, ?)')
      .run(Number(info.lastInsertRowid), eventId);
    db.exec('COMMIT');
    res.status(201).json({ id: Number(info.lastInsertRowid), username: username.trim(), role });
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    throw e;
  }
});

adminRouter.post('/events/:id/assignments', (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.body?.userId);
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
  if (!event || !user) return res.status(404).json({ error: 'Event or user not found' });
  if (user.role === 'OWNER') return res.status(400).json({ error: 'Owner does not need an assignment' });
  db.prepare('INSERT OR IGNORE INTO event_assignments (user_id, event_id) VALUES (?, ?)')
    .run(userId, eventId);
  res.status(201).json({ ok: true });
});

adminRouter.delete('/events/:id/assignments/:userId', (req, res) => {
  db.prepare('DELETE FROM event_assignments WHERE event_id = ? AND user_id = ?')
    .run(Number(req.params.id), Number(req.params.userId));
  res.json({ ok: true });
});
