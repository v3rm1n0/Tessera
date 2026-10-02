import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_PASSWORD } from './validate.js';
import { resetBoundary } from './time.js';

export { resetBoundary };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(
  process.env.NODE_ENV === 'test' ? ':memory:' : path.join(DATA_DIR, 'tessera.db')
);

// connection settings (the schema itself is created by server/migrate.js)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

let eventColumnList = null;

/**
 * SELECT list with every column of `events` except the card backdrop BLOB, which must never ride
 * along in JSON responses or be read on every request. Computed lazily so it reflects the migrated schema.
 */
export function eventColumns() {
  if (!eventColumnList) {
    eventColumnList = db.prepare('PRAGMA table_info(events)').all()
      .map(column => column.name)
      .filter(name => name !== 'card_backdrop')
      .join(', ');
  }
  return eventColumnList;
}

export function getEvent(id) {
  return db.prepare(`SELECT ${eventColumns()} FROM events WHERE id = ?`).get(id);
}

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

/** A high-entropy, reasonably typeable random password for generated accounts. */
export function randomPassword() {
  return randomBytes(12).toString('base64url'); // ~16 chars, 96 bits
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Start of "today" for an event: its last reset time on the wall clock of its own time zone. */
export function eventBoundary(eventId) {
  const ev = db.prepare('SELECT reset_time, timezone FROM events WHERE id = ?').get(eventId);
  if (!ev) return null;
  return resetBoundary(ev.reset_time, new Date(), ev.timezone);
}

export function seedOwner() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'OWNER'").get();
  if (existing.n > 0) return null;
  const configured = process.env.OWNER_PASSWORD;
  if (configured && configured.length < MIN_PASSWORD) {
    throw new Error(`OWNER_PASSWORD must be at least ${MIN_PASSWORD} characters`);
  }
  const password = configured || randomPassword();
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('owner', hashPassword(password), 'OWNER');
  return { username: 'owner', password };
}
