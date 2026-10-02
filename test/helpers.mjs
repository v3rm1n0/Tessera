// Shared setup for API tests. Not a test file (the runner only picks up *.test.mjs).
// Every test file runs in its own process, so each one gets a fresh in-memory database.

export const OWNER_PASSWORD = 'test-owner-pw';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Boots the app on an ephemeral port against an in-memory database.
 * `env` entries are applied before the server modules load; pass null to unset a variable.
 */
export async function startTestApp(env = {}) {
  process.env.NODE_ENV = 'test';
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  const dbModule = await import('../server/db.js');
  const { createApp } = await import('../server/index.js');
  dbModule.seedOwner();

  const server = await new Promise(resolve => {
    const s = createApp().listen(0, () => resolve(s));
  });
  server.unref(); // let the test process exit once the tests are done
  const base = `http://localhost:${server.address().port}`;

  /** Returns a request function bound to a bearer token (or anonymous when token is falsy). */
  function as(token) {
    const call = async (method, path, body, { headers = {}, raw } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined && raw === undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // a handler that never answers fails the test instead of hanging it
      });
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    };
    call.token = token;
    return call;
  }

  async function login(username, password) {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
    return as((await res.json()).token);
  }

  /**
   * Creates an event through the owner API plus an EVENT_ADMIN and a SCANNER account assigned to it.
   * Returns { id, admin, scanner } where admin/scanner are logged-in request functions.
   */
  async function event(owner, name = 'Event') {
    const ev = await owner('POST', '/api/admin/events', { name });
    const id = ev.data.id;
    const accounts = {};
    for (const [key, role] of [['admin', 'EVENT_ADMIN'], ['scanner', 'SCANNER']]) {
      const username = `${key}${id}`;
      const password = `pw-${username}-12345`;
      await owner('POST', `/api/admin/events/${id}/users`, { username, password, role });
      accounts[key] = await login(username, password);
    }
    return { id, ...accounts };
  }

  return { base, db: dbModule.db, dbModule, server, as, login, event, close: () => server.close() };
}
