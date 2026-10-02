import { Router } from 'express';
import { attemptLogin, login, logout, requireAuth } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';

export const authRouter = Router();

// In-memory brute-force throttle (single-process app). Failed logins are counted
// per username and per source IP within a rolling window; too many block further
// attempts until the window elapses. A successful login clears the counters.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 8;
const MAX_PER_IP = 50;
const attempts = new Map(); // key -> { count, resetAt }

function count(key, now) {
  const b = attempts.get(key);
  return b && b.resetAt > now ? b.count : 0;
}

function fail(key, now) {
  let b = attempts.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + WINDOW_MS }; attempts.set(key, b); }
  b.count++;
}

// drop stale buckets lazily so the map can't grow without bound
function sweep(now) {
  if (attempts.size < 1000) return;
  for (const [k, b] of attempts) if (b.resetAt <= now) attempts.delete(k);
}

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new HttpError(400, 'CREDENTIALS_REQUIRED');
  }
  const now = Date.now();
  sweep(now);
  const ipKey = `ip:${req.ip}`;
  const userKey = `user:${String(username).toLowerCase()}`;
  const blocked = count(userKey, now) >= MAX_PER_USER || count(ipKey, now) >= MAX_PER_IP;
  if (blocked) {
    const reset = Math.max(attempts.get(userKey)?.resetAt || 0, attempts.get(ipKey)?.resetAt || 0);
    res.setHeader('Retry-After', Math.ceil((reset - now) / 1000));
    return res.status(429).json({ error: 'Too many attempts, please try again later' });
  }

  const user = attemptLogin(username, password);
  if (!user) {
    fail(userKey, now);
    fail(ipKey, now);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  attempts.delete(userKey);
  attempts.delete(ipKey);
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
