import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { backupTo } from '../server/backup.js';

const run = promisify(execFile);
const CLI = new URL('../server/backup.js', import.meta.url).pathname;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-backup-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
const fresh = () => path.join(root, `case-${++counter}`);

/** A small on-disk database in WAL mode, like the real one. */
function sourceDb(rows = 5, blobBytes = 3) {
  const dir = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tessera.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
  const insert = db.prepare('INSERT INTO items (name, data) VALUES (?, ?)');
  db.exec('BEGIN'); // one transaction: thousands of separate commits would each wait for the disk
  for (let i = 0; i < rows; i++) insert.run(`item ${i}`, Buffer.alloc(blobBytes, i % 256));
  db.exec('COMMIT');
  return { db, file, dir };
}

const open = file => new DatabaseSync(file, { readOnly: true });
const names = dir => fs.readdirSync(dir).sort();
const at = seconds => new Date(Date.UTC(2026, 6, 21, 9, 5, seconds));

test('the backup is a complete, openable database under a timestamped name', async () => {
  const { db } = sourceDb(5);
  const dir = fresh();
  const file = await backupTo(db, dir, { now: new Date(Date.UTC(2026, 6, 21, 9, 5, 3)) });
  assert.equal(file, path.join(dir, 'tessera-20260721-090503.db'));
  const copy = open(file);
  assert.deepEqual(copy.prepare('SELECT name FROM items ORDER BY id').all().map(r => r.name), ['item 0', 'item 1', 'item 2', 'item 3', 'item 4']);
  assert.deepEqual([...copy.prepare('SELECT data FROM items WHERE name = ?').get('item 2').data], [2, 2, 2]);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
});

test('the backup directory is created private, and so is every backup', async () => {
  const { db } = sourceDb(1);
  const dir = path.join(fresh(), 'nested', 'backups');
  const file = await backupTo(db, dir, { now: at(0) });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('only the newest `keep` backups stay, and nothing else in the folder is touched', async () => {
  const { db } = sourceDb(1);
  const dir = fresh();
  fs.mkdirSync(dir, { recursive: true });
  for (const other of ['notes.txt', 'tessera-old.db', 'tessera-20200101-000000.db.bak']) fs.writeFileSync(path.join(dir, other), 'mine');
  fs.mkdirSync(path.join(dir, 'tessera-20190101-000000.db')); // a folder that merely looks like a backup
  for (let s = 0; s < 5; s++) await backupTo(db, dir, { now: at(s), keep: 3 });
  assert.deepEqual(names(dir), [
    'notes.txt', 'tessera-20190101-000000.db', 'tessera-20200101-000000.db.bak',
    'tessera-20260721-090502.db', 'tessera-20260721-090503.db', 'tessera-20260721-090504.db', 'tessera-old.db',
  ]);
});

test('fourteen backups are kept by default', async () => {
  const { db } = sourceDb(1);
  const dir = fresh();
  for (let s = 0; s < 16; s++) await backupTo(db, dir, { now: at(s) });
  assert.equal(names(dir).length, 14);
  assert.equal(names(dir)[0], 'tessera-20260721-090502.db');
});

test('a second backup in the same second replaces the first cleanly', async () => {
  const { db } = sourceDb(1);
  const dir = fresh();
  await backupTo(db, dir, { now: at(7) });
  db.prepare('INSERT INTO items (name, data) VALUES (?, ?)').run('later', Buffer.alloc(1));
  const file = await backupTo(db, dir, { now: at(7) });
  assert.deepEqual(names(dir), ['tessera-20260721-090507.db'], 'no half-written leftovers');
  const copy = open(file);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
  copy.close();
});

test('keep must be a whole number of at least one, and an invalid value touches nothing', async () => {
  const { db } = sourceDb(1);
  const dir = fresh();
  await backupTo(db, dir, { now: at(1) });
  for (const keep of [0, -1, 1.5, NaN, Infinity, '3', null]) {
    await assert.rejects(backupTo(db, dir, { now: at(2), keep }), { name: 'RangeError', message: /keep/ }, String(keep));
  }
  assert.deepEqual(names(dir), ['tessera-20260721-090501.db']);
});

test('a failing backup leaves nothing half-written and keeps the older backups', async () => {
  const { db } = sourceDb(1);
  const dir = fresh();
  await backupTo(db, dir, { now: at(1) });
  const broken = sourceDb(1).db;
  broken.close();
  await assert.rejects(backupTo(broken, dir, { now: at(2) }));
  assert.deepEqual(names(dir), ['tessera-20260721-090501.db']);
});

// a stepwise copy is restarted by every write in between and never finishes: the timeout turns that into a failure, not a hang
test('a backup made while another connection keeps writing is a consistent snapshot', { timeout: 20_000 }, async () => {
  const { db, file } = sourceDb(3000, 600); // a few MB: the copy takes a while
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA busy_timeout = 5000');
  const insert = writer.prepare('INSERT INTO items (name, data) VALUES (?, ?)');
  let written = 0;
  let running = true;
  const pump = () => {
    if (!running) return;
    insert.run(`late ${written++}`, Buffer.alloc(200));
    setImmediate(pump);
  };
  setImmediate(pump);

  const out = await backupTo(db, fresh(), { now: at(0) });
  running = false;
  assert.ok(written > 0, 'the writer really was busy during the backup');

  const copy = open(out);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const { n, max } = copy.prepare('SELECT COUNT(*) AS n, MAX(id) AS max FROM items').get();
  assert.ok(n >= 3000, 'everything that existed before the backup began is in it');
  assert.equal(n, max, 'and what was written meanwhile is either all there or not at all, with no gaps');
  copy.close();
  writer.close();
});

// ---------------------------------------------------------------- the command line

const cli = (args, env = {}) => run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } })
  .then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

function dataDirWithDb(rows = 2) {
  const { db, dir } = sourceDb(rows);
  db.close();
  return dir;
}

test('the command backs up DATA_DIR/tessera.db into DATA_DIR/backups by default and prints the file', async () => {
  const dataDir = dataDirWithDb();
  const result = await cli([], { DATA_DIR: dataDir });
  assert.equal(result.code, 0, result.stderr);
  const printed = result.stdout.trim().split('\n').at(-1);
  assert.match(printed, new RegExp(`^${dataDir.replaceAll('/', '\\/')}\\/backups\\/tessera-\\d{8}-\\d{6}\\.db$`));
  const copy = open(printed);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
  copy.close();
});

test('a folder argument, BACKUP_DIR and --keep are honoured, in that order of precedence', async () => {
  const dataDir = dataDirWithDb();
  const viaEnv = fresh();
  const viaArg = fresh();
  assert.equal((await cli([], { DATA_DIR: dataDir, BACKUP_DIR: viaEnv })).code, 0);
  assert.equal(names(viaEnv).length, 1);
  assert.equal((await cli([viaArg], { DATA_DIR: dataDir, BACKUP_DIR: viaEnv })).code, 0);
  assert.equal(names(viaArg).length, 1);
  assert.equal(names(viaEnv).length, 1, 'the argument won over BACKUP_DIR');
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(viaArg, `tessera-2020010${i + 1}-000000.db`), 'old');
  }
  assert.equal((await cli([viaArg, '--keep', '2'], { DATA_DIR: dataDir })).code, 0);
  assert.equal(names(viaArg).length, 2);
});

test('the command explains what is wrong instead of a stack trace', async () => {
  const dataDir = dataDirWithDb();
  const noDb = await cli([], { DATA_DIR: fresh() });
  assert.equal(noDb.code, 1);
  assert.match(noDb.stderr, /No database found at .*tessera\.db/);
  for (const bad of [['--keep', '0'], ['--keep', 'abc'], ['--keep'], ['--keep', '2.5']]) {
    const result = await cli(bad, { DATA_DIR: dataDir });
    assert.equal(result.code, 1, bad.join(' '));
    assert.match(result.stderr, /--keep/);
  }
  const unknown = await cli(['--frobnicate'], { DATA_DIR: dataDir });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Usage: node server\/backup\.js/);
  assert.doesNotMatch(unknown.stderr, /at .*\.js:\d+/, 'no stack trace');
});
