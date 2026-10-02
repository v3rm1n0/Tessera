import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, MIGRATIONS } from '../server/migrate.js';

const ALL_IDS = MIGRATIONS.map(m => m.id);

test('runMigrations builds the full schema and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  assert.deepEqual(runMigrations(db), ALL_IDS);

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const t of ['users', 'sessions', 'events', 'event_assignments', 'sections',
    'tickets', 'scans', 'subsections', 'audit_log', 'schema_migrations']) {
    assert.ok(tables.has(t), `missing table ${t}`);
  }
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('sections').includes('color'));
  assert.ok(cols('tickets').includes('subsection_id'));
  assert.ok(cols('events').includes('card_title') && cols('events').includes('card_backdrop'));
  assert.ok(cols('events').includes('timezone'));
  assert.ok(cols('tickets').includes('holder') && cols('tickets').includes('revoked_at'));
  assert.ok(cols('scans').includes('voided_at') && cols('scans').includes('voided_by'));

  // a second run applies nothing
  assert.deepEqual(runMigrations(db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, ALL_IDS.length);
});

test('runMigrations is safe on a legacy DB that already has the schema', () => {
  const db = new DatabaseSync(':memory:');
  // legacy install: final-ish schema, a stale per-section card column, a
  // colorless section, and no schema_migrations table
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, reset_time TEXT DEFAULT '00:00',
      created_at INTEGER DEFAULT 0, card_title TEXT DEFAULT '');
    CREATE TABLE sections (id INTEGER PRIMARY KEY, event_id INTEGER, name TEXT,
      created_at INTEGER DEFAULT 0, color TEXT DEFAULT '', card_text TEXT DEFAULT '');
    INSERT INTO events (id, name) VALUES (1, 'Alt');
    INSERT INTO sections (id, event_id, name) VALUES (1, 1, 'S');
  `);

  assert.deepEqual(runMigrations(db), ALL_IDS);

  // stale per-section card column dropped, colorless section backfilled
  assert.ok(!db.prepare('PRAGMA table_info(sections)').all().map(c => c.name).includes('card_text'));
  assert.match(db.prepare('SELECT color FROM sections WHERE id = 1').get().color, /^#[0-9a-f]{6}$/i);
  // existing data preserved
  assert.equal(db.prepare('SELECT name FROM events WHERE id = 1').get().name, 'Alt');

  // the reset time used to be read in the server's zone; that zone is now recorded explicitly
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(db.prepare('SELECT timezone FROM events WHERE id = 1').get().timezone, serverZone);
  db.prepare("UPDATE events SET timezone = 'UTC' WHERE id = 1").run();
  assert.deepEqual(runMigrations(db), [], 'nothing runs twice');
  assert.equal(db.prepare('SELECT timezone FROM events WHERE id = 1').get().timezone, 'UTC', 'a later choice is not overwritten');
});
