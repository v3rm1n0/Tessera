// Import this first in any test that loads server modules: it forces the in-memory database so a
// test can never open the real data/tessera.db. (ES module imports run in order.)
process.env.NODE_ENV = 'test';
process.env.OWNER_PASSWORD ??= 'test-owner-pw';
