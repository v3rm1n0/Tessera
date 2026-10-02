import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.mjs';

let app;

before(async () => {
  app = await startTestApp({}, {
    wrap(inner, express) {
      const outer = express();
      // a handler that rejects, as any async route would on a database or library error
      outer.get('/api/__boom', async () => { throw new Error('boom'); });
      outer.use(inner);
      return outer;
    },
  });
});

test('a rejected async handler becomes a 500 and the server keeps serving', async () => {
  const anon = app.as(null);
  const res = await anon('GET', '/api/__boom');
  assert.equal(res.status, 500);
  assert.equal((await anon('GET', '/api/me')).status, 401, 'server still answers afterwards');
});
