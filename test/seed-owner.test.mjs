import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, seedOwner } = await import('../server/db.js');
const { runMigrations } = await import('../server/migrate.js');
runMigrations(db);

test('seedOwner refuses a configured password that is too short', () => {
  process.env.OWNER_PASSWORD = 'short';
  assert.throws(() => seedOwner(), /OWNER_PASSWORD must be at least 8 characters/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'nothing was created');
});

test('seedOwner accepts a configured password of sufficient length', () => {
  process.env.OWNER_PASSWORD = 'long-enough-1';
  assert.deepEqual(seedOwner(), { username: 'owner', password: 'long-enough-1' });
  assert.equal(seedOwner(), null, 'a second call finds the owner and does nothing');
});

test('without a configured password a random one is generated', () => {
  delete process.env.OWNER_PASSWORD;
  db.prepare('DELETE FROM users').run();
  const seeded = seedOwner();
  assert.ok(seeded.password.length >= 8);
});
