import { Router } from 'express';
import { attemptLogin, login, logout, requireAuth } from '../auth.js';
import { db } from '../db.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }
  const user = attemptLogin(username, password);
  if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  const token = login(res, user.id);
  res.json({ id: user.id, username: user.username, role: user.role, token });
});

authRouter.post('/logout', (req, res) => {
  logout(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const events = req.user.role === 'OWNER'
    ? db.prepare('SELECT id, name, reset_time FROM events ORDER BY name').all()
    : db.prepare(`
        SELECT e.id, e.name, e.reset_time FROM events e
        JOIN event_assignments a ON a.event_id = e.id
        WHERE a.user_id = ? ORDER BY e.name
      `).all(req.user.id);
  res.json({ ...req.user, events });
});
