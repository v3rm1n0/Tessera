import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { db } from '../db.js';
import { requireRole, requireEventAccess, requireSectionAccess } from '../auth.js';

/**
 * EventAdmin functionality. Deliberately EVENT_ADMIN-only: sections, UUIDs
 * and QR codes are managed exclusively by the event admins of an event.
 */
export const eventsRouter = Router();
const manage = requireRole('EVENT_ADMIN');

// ------------------------------------------------------------- reset time

eventsRouter.patch('/events/:eventId', manage, requireEventAccess, (req, res) => {
  const resetTime = req.body?.reset_time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(resetTime || '')) {
    return res.status(400).json({ error: 'reset_time muss das Format HH:MM haben' });
  }
  db.prepare('UPDATE events SET reset_time = ? WHERE id = ?').run(resetTime, req.event.id);
  res.json({ ...req.event, reset_time: resetTime });
});

// --------------------------------------------------------------- sections

eventsRouter.post('/events/:eventId/sections', manage, requireEventAccess, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const info = db.prepare('INSERT INTO sections (event_id, name) VALUES (?, ?)')
      .run(req.event.id, name);
    res.status(201).json({ id: Number(info.lastInsertRowid), event_id: req.event.id, name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Abteilung existiert bereits' });
    }
    throw e;
  }
});

eventsRouter.delete('/sections/:sectionId', manage, requireSectionAccess, (req, res) => {
  db.prepare('DELETE FROM sections WHERE id = ?').run(req.section.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- tickets

eventsRouter.post('/sections/:sectionId/tickets', manage, requireSectionAccess, (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    return res.status(400).json({ error: 'count muss zwischen 1 und 10000 liegen' });
  }
  const insert = db.prepare('INSERT INTO tickets (uuid, section_id) VALUES (?, ?)');
  const uuids = [];
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const uuid = randomUUID();
      insert.run(uuid, req.section.id);
      uuids.push(uuid);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.status(201).json({ created: count, uuids });
});

eventsRouter.get('/sections/:sectionId/tickets', manage, requireSectionAccess, (req, res) => {
  res.json(db.prepare(
    'SELECT uuid, created_at FROM tickets WHERE section_id = ? ORDER BY created_at, uuid'
  ).all(req.section.id));
});

// ------------------------------------------------------------ Excel export

eventsRouter.get('/events/:eventId/tickets.xlsx', manage, requireEventAccess, async (req, res) => {
  const sections = db.prepare('SELECT * FROM sections WHERE event_id = ? ORDER BY name')
    .all(req.event.id);
  const wb = new ExcelJS.Workbook();
  for (const section of sections) {
    // sheet names: max 31 chars, no \ / ? * [ ] :
    const sheet = wb.addWorksheet(section.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Abteilung');
    sheet.columns = [
      { header: 'Abteilung', key: 'section', width: 30 },
      { header: 'UUID', key: 'uuid', width: 40 },
      { header: 'Erstellt', key: 'created', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    const tickets = db.prepare(
      'SELECT uuid, created_at FROM tickets WHERE section_id = ? ORDER BY created_at, uuid'
    ).all(section.id);
    for (const t of tickets) {
      sheet.addRow({ section: section.name, uuid: t.uuid, created: new Date(t.created_at) });
    }
  }
  if (sections.length === 0) wb.addWorksheet('Leer');
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="uuids-event-${req.event.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// -------------------------------------------------------------- QR codes

const escapeXml = s => s.replace(/[<>&'"]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/**
 * A printable QR label: section name on top, QR in the middle, UUID below.
 */
async function qrLabelSvg(sectionName, uuid) {
  const qr = await QRCode.toString(uuid, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  // embed the generated QR as a nested <svg> positioned inside the label
  const inner = qr
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace('<svg ', '<svg x="40" y="70" width="320" height="320" ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="470" viewBox="0 0 400 470">
  <rect width="400" height="470" fill="#ffffff"/>
  <text x="200" y="45" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="24" font-weight="bold" fill="#000000">${escapeXml(sectionName)}</text>
  ${inner}
  <text x="200" y="430" text-anchor="middle" font-family="monospace"
        font-size="15" fill="#000000">${escapeXml(uuid)}</text>
</svg>`;
}

eventsRouter.get('/sections/:sectionId/qrcodes.zip', manage, requireSectionAccess, async (req, res) => {
  const tickets = db.prepare(
    'SELECT uuid FROM tickets WHERE section_id = ? ORDER BY created_at, uuid'
  ).all(req.section.id);
  const safeName = req.section.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="qrcodes-${safeName}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  for (const t of tickets) {
    archive.append(await qrLabelSvg(req.section.name, t.uuid), {
      name: `${safeName}-${t.uuid}.svg`,
    });
  }
  await archive.finalize();
});

eventsRouter.get('/sections/:sectionId/qrcodes/print', manage, requireSectionAccess, async (req, res) => {
  const tickets = db.prepare(
    'SELECT uuid FROM tickets WHERE section_id = ? ORDER BY created_at, uuid'
  ).all(req.section.id);
  const labels = await Promise.all(tickets.map(t => qrLabelSvg(req.section.name, t.uuid)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>QR-Codes – ${escapeXml(req.section.name)}</title>
<style>
  body { margin: 1cm; font-family: sans-serif; }
  .grid { display: flex; flex-wrap: wrap; gap: 8mm; }
  .grid svg { width: 62mm; height: auto; border: 0.3mm solid #ccc; page-break-inside: avoid; }
  @media print { .noprint { display: none; } }
</style></head><body>
<p class="noprint"><button onclick="print()">Drucken</button> ${tickets.length} QR-Codes</p>
<div class="grid">${labels.join('\n')}</div>
</body></html>`);
});
