import { randomBytes } from 'node:crypto';
import { db, verifyPassword, hashPassword, getEvent } from './db.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE = 'tessera_session';

// a real hash to verify against when the username is unknown, so a missing
// account costs the same scrypt work as a wrong password (no timing oracle)
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

// mark the cookie Secure in production (served over HTTPS); left off in dev/test
// so http://localhost keeps working
const SECURE = process.env.NODE_ENV === 'production' ? ' Secure;' : '';

/** Value of one cookie from a Cookie header; undefined when absent or not decodable. */
export function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return undefined; }
    }
  }
  return undefined;
}

/** Attaches req.user for a valid session. Sources, in order: bearer header, session cookie. */
export function sessionMiddleware(req, res, next) {
  const bearer = (req.headers.authorization || '').match(/^Bearer (\w+)$/)?.[1];
  const token = bearer || readCookie(req.headers.cookie, COOKIE);
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.role, s.token, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
    if (row) {
      if (row.expires_at > Date.now()) {
        req.user = { id: row.id, username: row.username, role: row.role };
        req.sessionToken = row.token;
      } else {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
    }
  }
  next();
}

export function login(res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly;${SECURE} SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  return token;
}

export function logout(req, res) {
  if (req.sessionToken) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly;${SECURE} SameSite=Strict; Path=/; Max-Age=0`);
}

export function attemptLogin(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // hash even when the user is missing to keep the response time constant
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return null;
  return user;
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    next();
  };
}

/** True if the user may access the event (OWNER always, others via assignment). */
export function canAccessEvent(user, eventId) {
  if (user.role === 'OWNER') return true;
  const row = db.prepare(
    'SELECT 1 FROM event_assignments WHERE user_id = ? AND event_id = ?'
  ).get(user.id, eventId);
  return !!row;
}

export function requireEventAccess(req, res, next) {
  const eventId = Number(req.params.eventId);
  const event = getEvent(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!canAccessEvent(req.user, eventId)) {
    return res.status(403).json({ error: 'Not authorized for this event' });
  }
  req.event = event;
  next();
}

/** Express guard for routes with :sectionId — resolves section + event access. */
export function requireSectionAccess(req, res, next) {
  const section = db.prepare('SELECT * FROM sections WHERE id = ?')
    .get(Number(req.params.sectionId));
  if (!section) return res.status(404).json({ error: 'Section not found' });
  if (!canAccessEvent(req.user, section.event_id)) {
    return res.status(403).json({ error: 'Not authorized for this event' });
  }
  req.section = section;
  req.event = getEvent(section.event_id);
  next();
}
