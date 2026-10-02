// Online backup of the SQLite database: a consistent copy while the app keeps running.
//
//   node server/backup.js [dir] [--keep N]
//
// The copy goes to `dir` (default: $BACKUP_DIR, else <DATA_DIR>/backups) as tessera-YYYYMMDD-HHMMSS.db
// (UTC), and only the newest N (default 14) of those files are kept. Restoring is stopping the app and
// copying a backup over <DATA_DIR>/tessera.db.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

export const DEFAULT_KEEP = 14;

const BACKUP_NAME = /^tessera-\d{8}-\d{6}\.db$/; // the only files pruning ever touches
const WHOLE_DATABASE = 2 ** 31 - 1;              // pages per step: all of them
const USAGE = 'Usage: node server/backup.js [dir] [--keep N]';

const stamp = date => date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/**
 * Copies `sourceDb` (an open DatabaseSync) into `dir` and prunes older backups beyond `keep`; resolves to
 * the new file. The copy is made in one step, i.e. from a single snapshot: SQLite restarts a stepwise
 * backup whenever another connection writes in between, which a busy event could repeat forever.
 * It is written under a temporary name, checked, and only then moved into place, so a failure never
 * leaves a broken file that looks like a backup nor costs an older one.
 */
export async function backupTo(sourceDb, dir, { keep = DEFAULT_KEEP, now = new Date() } = {}) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RangeError(`keep must be a whole number of at least 1 (got ${keep})`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `tessera-${stamp(now)}.db`);
  const partial = `${file}.partial`;

  try {
    await backup(sourceDb, partial, { rate: WHOLE_DATABASE });
    const copy = new DatabaseSync(partial);
    try {
      const verdict = copy.prepare('PRAGMA integrity_check').get().integrity_check;
      if (verdict !== 'ok') throw new Error(`the copy failed its integrity check: ${verdict}`);
      copy.exec('PRAGMA journal_mode = DELETE'); // one self-contained file, no -wal/-shm beside it
    } finally {
      copy.close();
    }
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }

  const backups = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort(); // the names sort chronologically
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) fs.rmSync(path.join(dir, old));
  return file;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1) throw new Error('--keep needs a whole number of at least 1');
      options.keep = Number(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else if (options.dir === undefined) {
      options.dir = arg;
    } else {
      throw new Error('Too many arguments');
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const dbFile = path.join(dataDir, 'tessera.db');
  if (!fs.existsSync(dbFile)) {
    console.error(`No database found at ${dbFile}`);
    process.exit(1);
  }

  const dir = path.resolve(options.dir || process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    console.log(await backupTo(db, dir, { keep: options.keep }));
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
