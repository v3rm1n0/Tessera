/**
 * Resets (or creates) the owner account password.
 * Usage: node server/reset-owner.js [new-password]
 * Without an argument a random password is generated and printed.
 */
import { db, hashPassword, randomPassword, ownerBanner } from './db.js';
import { runMigrations } from './migrate.js';
import { MIN_PASSWORD } from './validate.js';

// ensure the schema exists; the server does this on boot, but this script
// may run first on a fresh install (idempotent — a no-op once migrated)
runMigrations(db);

const password = process.argv[2] || randomPassword();
if (password.length < MIN_PASSWORD) {
  console.error(`Password must be at least ${MIN_PASSWORD} characters.`);
  process.exit(1);
}

const owner = db.prepare("SELECT id, username FROM users WHERE role = 'OWNER'").get();
let username;
if (owner) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), owner.id);
  // kick out any existing sessions of the owner account
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
  username = owner.username;
} else {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('owner', hashPassword(password), 'OWNER');
  username = 'owner';
}

console.log(ownerBanner({ username, password, heading: 'Owner password set' }));
