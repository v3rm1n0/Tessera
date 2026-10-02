import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedOwner } from './db.js';
import { runMigrations } from './migrate.js';
import { sessionMiddleware, purgeExpiredSessions } from './auth.js';
import { HttpError, errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { eventsRouter } from './routes/events.js';
import { ticketsRouter } from './routes/tickets.js';
import { dashboardRouter } from './routes/dashboard.js';
import { historyRouter } from './routes/history.js';
import { reportsRouter } from './routes/reports.js';
import { scanRouter } from './routes/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// bring the schema up to date before the app (or any test) touches the db
runMigrations(db);

// Self-hosted app: everything loads from same origin. Inline style attributes
// are used throughout the UI, so style-src keeps 'unsafe-inline'; scripts do not.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/**
 * TRUST_PROXY takes what Express's "trust proxy" setting takes: true/false, a hop count, or a
 * subnet list such as "loopback, 10.0.0.0/8". Unset leaves proxies untrusted.
 */
export function parseTrustProxy(value) {
  const v = String(value ?? '').trim();
  if (v === '') return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** PORT (default 3000) and HOST (default: all interfaces). */
export function resolveListen(env = process.env) {
  return { port: Number(env.PORT || 3000), host: env.HOST || undefined };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware);

  app.use('/api', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', eventsRouter);
  app.use('/api', ticketsRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', historyRouter);
  app.use('/api', reportsRouter);
  app.use('/api', scanRouter);
  // whatever is left under /api is a JSON 404, never the app shell
  app.use('/api', (req, res, next) => next(new HttpError(404, 'NOT_FOUND')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // SPA fallback for client-side routes; a path with a file extension is a missing asset, not a route
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  app.use(errorHandler);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seeded = seedOwner();
  if (seeded) {
    console.log('==============================================');
    console.log('  Owner-Konto angelegt:');
    console.log(`  Benutzer: ${seeded.username}`);
    console.log(`  Passwort: ${seeded.password}`);
    console.log('==============================================');
  }
  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
  const { port, host } = resolveListen();
  createApp().listen(port, host, () => {
    console.log(`Tessera is running on http://${host || 'localhost'}:${port}`);
    console.log('Note: Camera access in browser requires HTTPS or localhost.');
  });
}
