import { Router } from 'express';
import { attemptLogin, login, logout, requireAuth } from '../auth.js';
import { db } from '../db.js';
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
