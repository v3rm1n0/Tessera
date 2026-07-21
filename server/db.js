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

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('OWNER','EVENT_ADMIN','SCANNER')),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    -- daily scan-count reset time, "HH:MM", configured by the EventAdmin
    reset_time TEXT NOT NULL DEFAULT '00:00'
               CHECK (reset_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );

  -- which EVENT_ADMIN / SCANNER accounts may access which event
  CREATE TABLE IF NOT EXISTS event_assignments (
    user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS sections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    UNIQUE (event_id, name)
  );

  -- one row per admission ID (the QR code payload is the uuid)
  CREATE TABLE IF NOT EXISTS tickets (
    uuid       TEXT PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_section ON tickets(section_id);

  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_uuid TEXT NOT NULL REFERENCES tickets(uuid) ON DELETE CASCADE,
    section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    scanned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    result      TEXT NOT NULL CHECK (result IN ('OK','DOUBLE')),
    -- chronological number of the scan within its section since the last reset
    -- (only set for OK scans)
    scan_number INTEGER,
    scanned_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_scans_section_time ON scans(section_id, scanned_at);
  CREATE INDEX IF NOT EXISTS idx_scans_ticket_time  ON scans(ticket_uuid, scanned_at);
`);

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
