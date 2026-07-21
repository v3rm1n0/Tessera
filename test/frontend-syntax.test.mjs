import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The view modules pull in app.js's browser-only startup side effects, so they
// can't be imported under node:test. `node --check` parses them without running,
// catching syntax errors that would otherwise only surface as a blank page.
const root = fileURLToPath(new URL('../public/js/', import.meta.url));
const files = [
  ...readdirSync(root).filter(f => f.endsWith('.js')).map(f => root + f),
  ...readdirSync(root + 'views').filter(f => f.endsWith('.js')).map(f => root + 'views/' + f),
];

for (const file of files) {
  test(`parses: ${file.slice(root.length)}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file]));
  });
}
