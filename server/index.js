import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedOwner } from './db.js';
import { runMigrations } from './migrate.js';
import { sessionMiddleware } from './auth.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { eventsRouter } from './routes/events.js';
import { dashboardRouter } from './routes/dashboard.js';
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

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware);

  app.use('/api', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', eventsRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', scanRouter);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // SPA fallback for client-side routes
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

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
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`Tessera is running on http://localhost:${port}`);
    console.log('Note: Camera access in browser requires HTTPS or localhost.');
  });
}
