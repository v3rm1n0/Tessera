import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(
  process.env.NODE_ENV === 'test' ? ':memory:' : path.join(DATA_DIR, 'voreinlass.db')
);

// connection settings (the schema itself is created by server/migrate.js)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ------------------------------------------------------------------ colors

/** Distinct, dashboard-friendly palette for randomly assigned section colors. */
export const SECTION_COLORS = [
  '#2dd4a7', '#4f9cf5', '#f5a94b', '#e46fc3', '#8f7ff7',
  '#f0556a', '#3fc1c9', '#a3d94e', '#f5d90a', '#fa8c5c',
  '#6ee7f0', '#c98850',
];

/** Picks a random color, avoiding ones already used within the event. */
export function pickSectionColor(eventId) {
  const used = db.prepare('SELECT color FROM sections WHERE event_id = ?')
    .all(eventId).map(r => r.color);
  const free = SECTION_COLORS.filter(c => !used.includes(c));
  const pool = free.length > 0 ? free : SECTION_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------- passwords

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return scryptSync(password, salt, 64).toString('hex') === hash;
}

// ---------------------------------------------------------------- reset time

/**
 * Timestamp (ms) of the most recent daily reset for an event.
 * "Today's" scans are all scans with scanned_at >= this boundary, which
 * makes counts reset precisely at the configured time without any cron job.
 */
export function resetBoundary(resetTime, now = new Date()) {
  const [h, m] = resetTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(h, m, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

export function eventBoundary(eventId) {
  const ev = db.prepare('SELECT reset_time FROM events WHERE id = ?').get(eventId);
  if (!ev) return null;
  return resetBoundary(ev.reset_time);
}

// ---------------------------------------------------------------- seeding

export function seedOwner() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'OWNER'").get();
  if (existing.n > 0) return null;
  const password = process.env.OWNER_PASSWORD || randomUUID().slice(0, 8);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('owner', hashPassword(password), 'OWNER');
  return { username: 'owner', password };
}
