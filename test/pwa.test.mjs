import './env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestApp } from './helpers.mjs';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const ORIGIN = 'http://app.test';

let app;
before(async () => { app = await startTestApp(); });

const get = pathname => fetch(app.base + pathname);

/** Width and height from the IHDR chunk of a PNG. */
function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(buf.subarray(12, 16).toString(), 'IHDR');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/** Every file below public/, as the URL path it is served under. */
function filesOnDisk(dir = PUBLIC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesOnDisk(full) : ['/' + path.relative(PUBLIC, full)];
  });
}

// ---------------------------------------------------------------- manifest, icons, headers

test('the manifest is served with its own media type and describes an installable app', async () => {
  const res = await get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
  const manifest = await res.json();
  assert.equal(manifest.name, 'Tessera');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  const purposes = manifest.icons.map(icon => `${icon.sizes}:${icon.purpose ?? 'any'}`);
  for (const wanted of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(purposes.includes(wanted), wanted);
});

test('every icon in the manifest exists, and PNGs have the size they declare', async () => {
  const manifest = await (await get('/manifest.webmanifest')).json();
  for (const icon of manifest.icons) {
    const res = await get(icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type').split(';')[0], icon.type, icon.src);
    if (icon.type === 'image/png') assert.equal(pngSize(Buffer.from(await res.arrayBuffer())), icon.sizes, icon.src);
  }
});

test('the service worker is always revalidated, so a new version is noticed', async () => {
  const res = await get('/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
});

test('the page links the manifest and the icons', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/icons\/icon\.svg">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/icon-maskable-512\.png">/);
});

// ---------------------------------------------------------------- the service worker itself

const SW_SOURCE = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

const absolute = target => new URL(typeof target === 'string' ? target : target.url, ORIGIN).href;

/** In-memory CacheStorage: bodies are stored once, every match hands out a clone. */
function fakeCaches(fetchImpl) {
  const stores = new Map();
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(request) { return store.get(absolute(request))?.clone(); },
      async put(request, response) { store.set(absolute(request), response); },
      async addAll(urls) {
        for (const url of urls) {
          const response = await fetchImpl({ url: absolute(url), method: 'GET' });
          if (!response.ok) throw new TypeError(`addAll: ${url} answered ${response.status}`);
          store.set(absolute(url), response);
        }
      },
    };
  };
  return {
    stores,
    open,
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const name of stores.keys()) {
        const hit = await (await open(name)).match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function loadServiceWorker(fetchImpl) {
  const listeners = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { self.skipped = true; return Promise.resolve(); },
    clients: { claim: () => { self.claimed = true; return Promise.resolve(); } },
  };
  const caches = fakeCaches(fetchImpl);
  vm.runInNewContext(SW_SOURCE, {
    self, caches, fetch: fetchImpl, Response, URL, Promise, console, clearTimeout,
    setTimeout: fn => setTimeout(fn, 10), // the navigation timeout, shortened
  });

  const lifecycle = async type => {
    const waits = [];
    listeners[type]({ waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
  };
  return {
    self,
    caches,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    /** Plays a fetch event; `handled` is whether the worker answered it itself. */
    async fetch(request) {
      let answer;
      const waits = [];
      listeners.fetch({ request, respondWith: promise => { answer = Promise.resolve(promise); }, waitUntil: promise => waits.push(promise) });
      const response = answer ? await answer : undefined;
      await Promise.all(waits); // background refreshes finish before the test looks at the cache
      return { handled: Boolean(answer), response };
    },
    async cached(pathname, name = 'tessera-static-v1') {
      const hit = await (await caches.open(name)).match(pathname);
      return hit ? hit.text() : undefined;
    },
    async seed(pathname, body, name = 'tessera-static-v1') {
      await (await caches.open(name)).put(pathname, new Response(body));
    },
  };
}

const page = (pathname, extra = {}) => ({ url: ORIGIN + pathname, method: 'GET', mode: 'no-cors', ...extra });
const navigation = pathname => page(pathname, { mode: 'navigate' });
const respond = (body, init) => async () => new Response(body, init);
const offline = async () => { throw new TypeError('Failed to fetch'); };
const never = () => new Promise(() => {});

test('installing caches every file of the app and takes over at once', async () => {
  const requested = [];
  const sw = loadServiceWorker(async request => { requested.push(new URL(request.url).pathname); return new Response('x'); });
  await sw.install();
  assert.equal(sw.self.skipped, true);
  const expected = filesOnDisk().filter(file => file !== '/sw.js').sort();
  assert.deepEqual([...requested].sort(), expected, 'the list in sw.js matches the files below public/');
  assert.deepEqual([...(sw.caches.stores.get('tessera-static-v1')).keys()].map(url => new URL(url).pathname).sort(), expected);
});

test('activating removes the caches of older versions, and only ours', async () => {
  const sw = loadServiceWorker(respond('x'));
  await sw.seed('/a', 'old', 'tessera-static-v0');
  await sw.seed('/b', 'current', 'tessera-static-v1');
  await sw.seed('/c', 'other', 'somebody-else');
  await sw.activate();
  assert.deepEqual(await sw.caches.keys(), ['tessera-static-v1', 'somebody-else']);
  assert.equal(sw.self.claimed, true);
});

test('the API, other origins and writes are left to the network', async () => {
  const sw = loadServiceWorker(respond('x'));
  assert.equal((await sw.fetch(page('/api/me'))).handled, false);
  assert.equal((await sw.fetch(page('/api/events/1/scans.xlsx'))).handled, false);
  assert.equal((await sw.fetch({ url: 'https://elsewhere.test/js/app.js', method: 'GET', mode: 'cors' })).handled, false);
  assert.equal((await sw.fetch(page('/js/app.js', { method: 'POST' }))).handled, false);
  assert.equal((await sw.fetch(page('/sw.js'))).handled, false);
  assert.equal((await sw.fetch(page('/healthz'))).handled, false, 'a health probe is never answered from a cache');
});

test('a static file comes from the cache at once and is refreshed in the background', async () => {
  let served = 'v2';
  const sw = loadServiceWorker(async () => new Response(served));
  await sw.seed('/js/app.js', 'v1');
  const first = await sw.fetch(page('/js/app.js'));
  assert.equal(await first.response.text(), 'v1', 'the cached copy is answered');
  assert.equal(await sw.cached('/js/app.js'), 'v2', 'and the cache has the new one afterwards');
  served = 'v3';
  assert.equal(await (await sw.fetch(page('/js/app.js'))).response.text(), 'v2');
});

test('a static file that is not cached yet is fetched and stored', async () => {
  const sw = loadServiceWorker(respond('fresh'));
  const { response } = await sw.fetch(page('/css/app.css'));
  assert.equal(await response.text(), 'fresh');
  assert.equal(await sw.cached('/css/app.css'), 'fresh');
});

test('offline, a cached static file still works; an uncached one fails like without a worker', async () => {
  const sw = loadServiceWorker(offline);
  await sw.seed('/js/app.js', 'v1');
  assert.equal(await (await sw.fetch(page('/js/app.js'))).response.text(), 'v1');
  await assert.rejects(sw.fetch(page('/js/other.js')));
});

test('error responses are shown but never cached', async () => {
  const sw = loadServiceWorker(respond('missing', { status: 404 }));
  const { response } = await sw.fetch(page('/js/gone.js'));
  assert.equal(response.status, 404);
  assert.equal(await sw.cached('/js/gone.js'), undefined);
});

test('a page load goes to the network first and refreshes the cached shell', async () => {
  const sw = loadServiceWorker(respond('<html>new</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  await sw.seed('/index.html', '<html>old</html>');
  const { response } = await sw.fetch(navigation('/'));
  assert.equal(await response.text(), '<html>new</html>', 'a new deploy shows at once');
  assert.equal(await sw.cached('/index.html'), '<html>new</html>');
});

test('offline, any page load gets the cached shell', async () => {
  const sw = loadServiceWorker(offline);
  await sw.seed('/index.html', '<html>shell</html>');
  for (const pathname of ['/', '/index.html', '/anything']) {
    assert.equal(await (await sw.fetch(navigation(pathname))).response.text(), '<html>shell</html>', pathname);
  }
});

test('a network that does not answer falls back to the shell after a short wait', { timeout: 3000 }, async () => {
  const sw = loadServiceWorker(never);
  await sw.seed('/index.html', '<html>shell</html>');
  assert.equal(await (await sw.fetch(navigation('/'))).response.text(), '<html>shell</html>');
});

test('without a cached shell an offline page load fails like without a worker', async () => {
  const sw = loadServiceWorker(offline);
  const { response } = await sw.fetch(navigation('/'));
  assert.equal(response.type, 'error');
});

test('a page load answered with an error page does not replace the cached shell', async () => {
  const sw = loadServiceWorker(respond('Bad gateway', { status: 502, headers: { 'content-type': 'text/html' } }));
  await sw.seed('/index.html', '<html>shell</html>');
  const { response } = await sw.fetch(navigation('/'));
  assert.equal(response.status, 502);
  assert.equal(await sw.cached('/index.html'), '<html>shell</html>');
});
