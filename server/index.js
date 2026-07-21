import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedOwner } from './db.js';
import { sessionMiddleware } from './auth.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { eventsRouter } from './routes/events.js';
import { dashboardRouter } from './routes/dashboard.js';
import { scanRouter } from './routes/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  });
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
    console.log(`Voreinlass läuft auf http://localhost:${port}`);
    console.log('Hinweis: Kamera-Zugriff im Browser erfordert HTTPS oder localhost.');
  });
}
