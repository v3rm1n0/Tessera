import { fileURLToPath } from 'node:url';

/**
 * Versioned, idempotent schema migrations. Each has a stable `id` and an
 * `up(db)` safe to run on a fresh db or one already at the final schema.
 * Applied ids are recorded in `schema_migrations`, so each runs once.
 * Run standalone with: node server/migrate.js (or: npm run migrate).
 */

// self-contained: migrations must not depend on app code

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumn(db, table, column, definition) {
  if (!columns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dropColumn(db, table, column) {
  if (columns(db, table).includes(column)) {
    try { db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`); }
    catch { /* SQLite build without DROP COLUMN: leave the unused column */ }
  }
}

// frozen snapshot of the palette used to backfill legacy colorless sections
const LEGACY_PALETTE = [
  '#2dd4a7', '#4f9cf5', '#f5a94b', '#e46fc3', '#8f7ff7',
  '#f0556a', '#3fc1c9', '#a3d94e', '#f5d90a', '#fa8c5c',
  '#6ee7f0', '#c98850',
];

export const MIGRATIONS = [
  {
    id: '001-initial-schema',
    up(db) {
      db.exec(`
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
          reset_time TEXT NOT NULL DEFAULT '00:00'
                     CHECK (reset_time GLOB '[0-2][0-9]:[0-5][0-9]'),
          created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
        );

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
          scan_number INTEGER,
          scanned_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_scans_section_time ON scans(section_id, scanned_at);
        CREATE INDEX IF NOT EXISTS idx_scans_ticket_time  ON scans(ticket_uuid, scanned_at);
      `);
    },
  },

  {
    id: '002-section-colors',
    up(db) {
      addColumn(db, 'sections', 'color', "TEXT NOT NULL DEFAULT ''");
      // backfill any pre-existing colorless section, avoiding duplicates per event
      const rows = db.prepare("SELECT id, event_id FROM sections WHERE color = ''").all();
      for (const s of rows) {
        const used = db.prepare('SELECT color FROM sections WHERE event_id = ?')
          .all(s.event_id).map(r => r.color);
        const free = LEGACY_PALETTE.filter(c => !used.includes(c));
        const pool = free.length ? free : LEGACY_PALETTE;
        db.prepare('UPDATE sections SET color = ? WHERE id = ?')
          .run(pool[Math.floor(Math.random() * pool.length)], s.id);
      }
    },
  },

  {
    id: '003-subsections',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subsections (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          UNIQUE (section_id, name)
        );
      `);
      addColumn(db, 'tickets', 'subsection_id',
        'INTEGER REFERENCES subsections(id) ON DELETE SET NULL');
    },
  },

  {
    id: '004-event-admission-cards',
    up(db) {
      addColumn(db, 'events', 'card_title', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'events', 'card_text', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'events', 'card_backdrop', 'BLOB');
      addColumn(db, 'events', 'card_backdrop_mime', 'TEXT');
      // superseded per-section card columns (moved to events)
      for (const col of ['card_title', 'card_text', 'card_backdrop', 'card_backdrop_mime']) {
        dropColumn(db, 'sections', col);
      }
    },
  },
];

/** Applies every not-yet-applied migration in order, each in its own transaction; returns the applied ids. */
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
    );
  `);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const justApplied = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      record.run(migration.id);
      db.exec('COMMIT');
      justApplied.push(migration.id);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} fehlgeschlagen: ${e.message}`);
    }
  }
  return justApplied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db } = await import('./db.js');
  const applied = runMigrations(db);
  if (applied.length) {
    console.log(`${applied.length} Migration(en) angewendet:`);
    for (const id of applied) console.log(`  ✓ ${id}`);
  } else {
    console.log('Keine ausstehenden Migrationen – Schema ist aktuell.');
  }
}
