const KEY_MAX = 128;       // longest identifier that goes into a key, so huge usernames cannot bloat memory
const MAX_BUCKETS = 10_000; // hard cap on tracked keys; the oldest tenth is dropped when it is reached

/**
 * In-memory brute-force throttle for failed logins (single-process app). Each failure is counted
 * three ways inside a fixed window:
 *   - per (ip, username) pair  - blocks one client from hammering one account
 *   - per username (any ip)    - backstop against distributed guessing of one account
 *   - per ip (any username)    - backstop against password spraying
 * A pair limit that is much lower than the other two means one noisy client, or a whole venue
 * behind one address, cannot lock everybody out.
 */
export function createThrottle({
  windowMs = 15 * 60 * 1000, maxPerPair = 8, maxPerUser = 40, maxPerIp = 200,
} = {}) {
  const buckets = new Map(); // key -> { count, resetAt }; Map order is insertion order
  let lastSweep = 0;

  const norm = value => String(value ?? '').trim().toLowerCase().slice(0, KEY_MAX);
  const keysFor = (ip, user) => {
    const i = norm(ip);
    const u = norm(user);
    return { pair: `p:${i}|${u}`, user: `u:${u}`, ip: `i:${i}` };
  };
  const live = (key, now) => {
    const bucket = buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket : null;
  };

  function sweep(now) {
    if (now - lastSweep < Math.min(windowMs, 60_000)) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }

  function evictOldest() {
    let drop = Math.ceil(MAX_BUCKETS / 10);
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (--drop <= 0) break;
    }
  }

  return {
    /** { blocked: false } or { blocked: true, retryAfter } (seconds). */
    check(ip, user, now = Date.now()) {
      const keys = keysFor(ip, user);
      let until = 0;
      for (const [name, limit] of [['pair', maxPerPair], ['user', maxPerUser], ['ip', maxPerIp]]) {
        const bucket = live(keys[name], now);
        if (bucket && bucket.count >= limit) until = Math.max(until, bucket.resetAt);
      }
      return until ? { blocked: true, retryAfter: Math.ceil((until - now) / 1000) } : { blocked: false };
    },

    fail(ip, user, now = Date.now()) {
      sweep(now);
      if (buckets.size + 3 > MAX_BUCKETS) evictOldest();
      for (const key of Object.values(keysFor(ip, user))) {
        let bucket = live(key, now);
        if (!bucket) {
          bucket = { count: 0, resetAt: now + windowMs };
          buckets.set(key, bucket);
        }
        bucket.count++;
      }
    },

    /** A correct password clears the pair and username counters; the address counter stays, so a
     *  client that owns one valid account cannot reset its own spraying budget. */
    succeed(ip, user) {
      const keys = keysFor(ip, user);
      buckets.delete(keys.pair);
      buckets.delete(keys.user);
    },

    reset() { buckets.clear(); lastSweep = 0; },
    size() { return buckets.size; },
  };
}
