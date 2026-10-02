// Offline shell for the installed app. Static files are answered from the cache at once and
// refreshed in the background; page loads go to the network first (a new deploy shows immediately)
// and fall back to the cached shell when the network is down or too slow. The API is never cached.
const CACHE = 'tessera-static-v1';
const NAVIGATION_TIMEOUT_MS = 4000;

// every file below public/ (test/pwa.test.mjs fails when this list and the folder drift apart)
const PRECACHE = [
  '/css/app.css',
  '/css/fonts.css',
  '/fonts/figtree-latin-400-normal.woff2',
  '/fonts/figtree-latin-500-normal.woff2',
  '/fonts/figtree-latin-600-normal.woff2',
  '/fonts/figtree-latin-700-normal.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon-maskable.svg',
  '/icons/icon.svg',
  '/index.html',
  '/js/api.js',
  '/js/app.js',
  '/js/bars.js',
  '/js/camera.js',
  '/js/card-render.js',
  '/js/codes-query.js',
  '/js/download.js',
  '/js/i18n.js',
  '/js/icons.js',
  '/js/password.js',
  '/js/scan-result.js',
  '/js/session.js',
  '/js/settings.js',
  '/js/theme-init.js',
  '/js/theme.js',
  '/js/time-format.js',
  '/js/ui.js',
  '/js/vendor.js',
  '/js/view-host.js',
  '/js/views/account.js',
  '/js/views/admin.js',
  '/js/views/card.js',
  '/js/views/codes.js',
  '/js/views/dashboard.js',
  '/js/views/history.js',
  '/js/views/log.js',
  '/js/views/login.js',
  '/js/views/scanner.js',
  '/js/views/section.js',
  '/manifest.webmanifest',
  '/vendor/jsQR.js',
  '/vendor/jszip.js',
  '/vendor/qrcode-generator.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names
        .filter(name => name.startsWith('tessera-') && name !== CACHE)
        .map(name => caches.delete(name))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  event.respondWith(request.mode === 'navigate' ? loadPage(request, event) : staleWhileRevalidate(request, event));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Network first; the cached shell when offline or when the network does not answer in time. */
async function loadPage(request, event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      event.waitUntil(cache.put('/index.html', response.clone()));
    }
    return response;
  } catch {
    return (await cache.match('/index.html')) || Response.error();
  }
}

/** The cached copy at once, refreshed in the background; fetched and stored when not cached yet. */
async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async response => {
    if (response.ok) await cache.put(request, response.clone()).catch(() => {});
    return response;
  });
  if (!cached) return refresh;
  event.waitUntil(refresh.catch(() => {})); // offline: the cached copy stays
  return cached;
}
