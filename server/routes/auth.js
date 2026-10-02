import { Router } from 'express';
import { attemptLogin, login, logout, requireAuth } from '../auth.js';
import { db, hashPassword, verifyPassword } from '../db.js';
import { audit } from '../audit.js';
import { requirePassword } from '../validate.js';
import { HttpError } from '../errors.js';
import { createThrottle } from '../throttle.js';

export const authRouter = Router();

// Failed logins are throttled per (ip, username), per username and per ip; see server/throttle.js.
export const loginThrottle = createThrottle();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new HttpError(400, 'CREDENTIALS_REQUIRED');
  }
  const now = Date.now();
  const verdict = loginThrottle.check(req.ip, username, now);
  if (verdict.blocked) {
    res.setHeader('Retry-After', verdict.retryAfter);
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
  }

  const user = attemptLogin(username, password);
  if (!user) {
    loginThrottle.fail(req.ip, username, now);
    throw new HttpError(401, 'INVALID_CREDENTIALS');
  }
  loginThrottle.succeed(req.ip, username);
  const token = login(res, user.id);
  res.json({ id: user.id, username: user.username, role: user.role, token });
});

/**
 * Changes the signed-in user's own password. Wrong current passwords count towards the login
 * throttle; the device that changed it stays signed in, all other sessions end.
 */
authRouter.post('/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (typeof current !== 'string' || !current) throw new HttpError(400, 'CREDENTIALS_REQUIRED');
  const newPassword = requirePassword(next);

  const now = Date.now();
  const verdict = loginThrottle.check(req.ip, req.user.username, now);
  if (verdict.blocked) {
    res.setHeader('Retry-After', verdict.retryAfter);
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
  }
  const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, hash)) {
    loginThrottle.fail(req.ip, req.user.username, now);
    throw new HttpError(403, 'CURRENT_PASSWORD_WRONG');
  }
  if (newPassword === current) throw new HttpError(400, 'PASSWORD_UNCHANGED');
  loginThrottle.succeed(req.ip, req.user.username);

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(req, 'password.change', { target: req.user.username });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  logout(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const rows = req.user.role === 'OWNER'
    ? db.prepare('SELECT id, name, reset_time, timezone, start_date, end_date, archived_at FROM events ORDER BY name').all()
    : db.prepare(`
        SELECT e.id, e.name, e.reset_time, e.timezone, e.start_date, e.end_date, e.archived_at FROM events e
        JOIN event_assignments a ON a.event_id = e.id
        WHERE a.user_id = ? ORDER BY e.name
      `).all(req.user.id);
  const events = rows.map(({ archived_at: archivedAt, ...event }) => ({ ...event, archived: archivedAt !== null }));
  res.json({ ...req.user, events });
});
