import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { ownerBanner } = await import('../server/index.js');
const { MIGRATIONS, runMigrations } = await import('../server/migrate.js');

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const GERMAN = /Konto|Benutzer|Passwort|angelegt|gesetzt|Migration\(en\)|ausstehend|fehlgeschlagen|aktuell/;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-messages-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshDataDir = () => { const dir = path.join(scratch, `data-${++n}`); fs.mkdirSync(dir); return dir; };

/** A child process the way an operator runs it: its own DATA_DIR, no test settings. */
const node = (script, args, dataDir, extraEnv = {}) =>
  run(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dataDir, ...extraEnv } })
    .then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('the owner banner says what happened in English, with the credentials, in a frame', () => {
  const banner = ownerBanner({ username: 'owner', password: 'p4ss-w0rd-xyz' });
  assert.match(banner, /Owner account created/);
  assert.match(banner, /Username: owner/);
  assert.match(banner, /Password: p4ss-w0rd-xyz/);
  assert.doesNotMatch(banner, GERMAN);
  const lines = banner.split('\n');
  assert.match(lines[0], /^=+$/);
  assert.match(lines.at(-1), /^=+$/);
});

test('the banner can carry another heading, which the password reset uses', () => {
  const banner = ownerBanner({ username: 'owner', password: 'abcdefgh', heading: 'Owner password set' });
  assert.match(banner, /Owner password set:/);
  assert.doesNotMatch(banner, /Owner account created/);
});

test('a failing migration is named in the message, which says it failed', () => {
  const db = new DatabaseSync(':memory:');
  MIGRATIONS.push({ id: '999_broken', up() { throw new Error('boom'); } });
  try {
    assert.throws(() => runMigrations(db), /Migration 999_broken failed: boom/);
  } finally {
    MIGRATIONS.pop();
  }
});

test('the migrate command reports what it did in English', async () => {
  const dir = freshDataDir();
  const first = await node('server/migrate.js', [], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^Applied \d+ migrations?:$/m);
  assert.match(first.stdout, /^ {2}✓ \d{3}-[\w-]+$/m);
  const second = await node('server/migrate.js', [], dir);
  assert.match(second.stdout, /No pending migrations/);
  assert.doesNotMatch(first.stdout + second.stdout, GERMAN);
});

test('the password reset prints an English banner, and explains a too short password', async () => {
  const dir = freshDataDir();
  const ok = await node('server/reset-owner.js', ['a-long-enough-pw'], dir);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Owner password set:/);
  assert.match(ok.stdout, /Username: owner/);
  assert.match(ok.stdout, /Password: a-long-enough-pw/);
  assert.doesNotMatch(ok.stdout, GERMAN);

  const tooShort = await node('server/reset-owner.js', ['short'], dir);
  assert.equal(tooShort.code, 1);
  assert.match(tooShort.stderr, /Password must be at least 8 characters\./);
});

test('a first start prints the owner account in English before it listens', async () => {
  const dir = freshDataDir();
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no start within 15 s:\n${output}`)), 15_000);
      const check = () => { if (/Tessera is running/.test(output)) { clearTimeout(timer); resolve(); } else setTimeout(check, 50); };
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited with ${code}:\n${output}`)); });
      check();
    });
  } finally {
    child.kill();
  }
  assert.match(output, /Owner account created:\n\s+Username: owner\n\s+Password: \S+/);
  assert.doesNotMatch(output, GERMAN);
});
