import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VENDOR_FILES } from '../scripts/sync-vendor.mjs';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = path.join(ROOT, 'scripts', 'sync-vendor.mjs');
const VENDOR = path.join(ROOT, 'public', 'vendor');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-vendor-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const source = file => fs.readFileSync(path.join(ROOT, 'node_modules', file.from));
const cli = (...args) => run(process.execPath, [SCRIPT, ...args]).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('the vendored scripts are byte for byte the ones installed in node_modules', () => {
  for (const file of VENDOR_FILES) {
    assert.ok(fs.readFileSync(path.join(VENDOR, file.to)).equals(source(file)), `public/vendor/${file.to} differs from node_modules/${file.from}; run "bun run vendor"`);
  }
});

test('nothing else is vendored, so every file in public/vendor has a source that is checked', () => {
  assert.deepEqual(fs.readdirSync(VENDOR).sort(), VENDOR_FILES.map(f => f.to).sort());
});

test('--check passes when everything is in place, fails on any difference, and changes nothing', async () => {
  const dest = path.join(scratch, 'check');
  fs.cpSync(VENDOR, dest, { recursive: true });
  assert.equal((await cli('--check', '--dest', dest)).code, 0);

  const victim = path.join(dest, VENDOR_FILES[1].to);
  fs.appendFileSync(victim, '\n// tampered');
  const tampered = fs.readFileSync(victim);
  const result = await cli('--check', '--dest', dest);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(VENDOR_FILES[1].to.replace('.', '\\.')));
  assert.match(result.stderr, /bun run vendor/);
  assert.ok(fs.readFileSync(victim).equals(tampered), '--check never writes');

  fs.rmSync(path.join(dest, VENDOR_FILES[0].to));
  assert.equal((await cli('--check', '--dest', dest)).code, 1, 'a missing file counts as drift');
});

test('syncing restores drifted and missing files and is a no-op the second time', async () => {
  const dest = path.join(scratch, 'sync');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, VENDOR_FILES[2].to), 'old and wrong');

  const first = await cli('--dest', dest);
  assert.equal(first.code, 0, first.stderr);
  for (const file of VENDOR_FILES) assert.ok(fs.readFileSync(path.join(dest, file.to)).equals(source(file)), file.to);
  assert.match(first.stdout, /updated/);

  const second = await cli('--dest', dest);
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.stdout, /updated/);
  assert.equal((await cli('--check', '--dest', dest)).code, 0);
});

test('an unknown option is explained, not ignored', async () => {
  const result = await cli('--frobnicate');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: node scripts\/sync-vendor\.mjs/);
});
