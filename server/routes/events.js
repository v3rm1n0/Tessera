import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { db, pickSectionColor } from '../db.js';
import { requireRole, requireEventAccess, requireSectionAccess, canAccessEvent } from '../auth.js';

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

const COLOR_RE = /^#[0-9a-f]{6}$/i;

eventsRouter.post('/events/:eventId/sections', manage, requireEventAccess, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  const custom = req.body?.color;
  if (custom !== undefined && !COLOR_RE.test(custom)) {
    return res.status(400).json({ error: 'color muss das Format #rrggbb haben' });
  }
  const color = custom || pickSectionColor(req.event.id);
  try {
    const info = db.prepare('INSERT INTO sections (event_id, name, color) VALUES (?, ?, ?)')
      .run(req.event.id, name, color);
    res.status(201).json({ id: Number(info.lastInsertRowid), event_id: req.event.id, name, color });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Abteilung existiert bereits' });
    }
    throw e;
  }
});

eventsRouter.patch('/sections/:sectionId', manage, requireSectionAccess, (req, res) => {
  const color = req.body?.color;
  if (color !== undefined) {
    if (!COLOR_RE.test(color)) {
      return res.status(400).json({ error: 'color muss das Format #rrggbb haben' });
    }
    db.prepare('UPDATE sections SET color = ? WHERE id = ?').run(color, req.section.id);
  }
  res.json(db.prepare('SELECT * FROM sections WHERE id = ?').get(req.section.id));
});

eventsRouter.delete('/sections/:sectionId', manage, requireSectionAccess, (req, res) => {
  db.prepare('DELETE FROM sections WHERE id = ?').run(req.section.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------- subsections

eventsRouter.post('/sections/:sectionId/subsections', manage, requireSectionAccess, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const info = db.prepare('INSERT INTO subsections (section_id, name) VALUES (?, ?)')
      .run(req.section.id, name);
    res.status(201).json({ id: Number(info.lastInsertRowid), section_id: req.section.id, name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Unterabteilung existiert bereits' });
    }
    throw e;
  }
});

eventsRouter.get('/sections/:sectionId/subsections', manage, requireSectionAccess, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM subsections WHERE section_id = ? ORDER BY name')
    .all(req.section.id));
});

eventsRouter.delete('/subsections/:id', manage, (req, res) => {
  const sub = db.prepare(`
    SELECT sub.id, s.event_id FROM subsections sub
    JOIN sections s ON s.id = sub.section_id WHERE sub.id = ?
  `).get(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Unterabteilung nicht gefunden' });
  if (!canAccessEvent(req.user, sub.event_id)) {
    return res.status(403).json({ error: 'Keine Berechtigung für dieses Event' });
  }
  db.prepare('DELETE FROM subsections WHERE id = ?').run(sub.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- tickets

/** Display label of a ticket: "Section" or "Section – Subsection". */
export function ticketLabel(sectionName, subsectionName) {
  return subsectionName ? `${sectionName} – ${subsectionName}` : sectionName;
}

eventsRouter.post('/sections/:sectionId/tickets', manage, requireSectionAccess, (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    return res.status(400).json({ error: 'count muss zwischen 1 und 10000 liegen' });
  }
  let subsectionId = null;
  if (req.body?.subsection_id != null) {
    const sub = db.prepare('SELECT id FROM subsections WHERE id = ? AND section_id = ?')
      .get(Number(req.body.subsection_id), req.section.id);
    if (!sub) return res.status(400).json({ error: 'Unterabteilung gehört nicht zu dieser Abteilung' });
    subsectionId = sub.id;
  }
  const insert = db.prepare(
    'INSERT INTO tickets (uuid, section_id, subsection_id) VALUES (?, ?, ?)');
  const uuids = [];
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const uuid = randomUUID();
      insert.run(uuid, req.section.id, subsectionId);
      uuids.push(uuid);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.status(201).json({ created: count, uuids });
});

function sectionTickets(sectionId) {
  return db.prepare(`
    SELECT t.uuid, t.created_at, sub.name AS subsection
    FROM tickets t LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE t.section_id = ? ORDER BY t.created_at, t.uuid
  `).all(sectionId);
}

eventsRouter.get('/sections/:sectionId/tickets', manage, requireSectionAccess, (req, res) => {
  res.json(sectionTickets(req.section.id));
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
      { header: 'Unterabteilung', key: 'subsection', width: 30 },
      { header: 'UUID', key: 'uuid', width: 40 },
      { header: 'Erstellt', key: 'created', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const t of sectionTickets(section.id)) {
      sheet.addRow({
        section: section.name,
        subsection: t.subsection || '',
        uuid: t.uuid,
        created: new Date(t.created_at),
      });
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
 * A printable QR label: section (– subsection) on top, QR in the middle,
 * UUID below.
 */
async function qrLabelSvg(label, uuid) {
  const qr = await QRCode.toString(uuid, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  // embed the generated QR as a nested <svg> positioned inside the label
  const inner = qr
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace('<svg ', '<svg x="40" y="70" width="320" height="320" ');
  const fontSize = label.length > 24 ? 17 : 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="470" viewBox="0 0 400 470">
  <rect width="400" height="470" fill="#ffffff"/>
  <text x="200" y="45" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSize}" font-weight="bold" fill="#000000">${escapeXml(label)}</text>
  ${inner}
  <text x="200" y="430" text-anchor="middle" font-family="monospace"
        font-size="15" fill="#000000">${escapeXml(uuid)}</text>
</svg>`;
}

eventsRouter.get('/sections/:sectionId/qrcodes.zip', manage, requireSectionAccess, async (req, res) => {
  const tickets = sectionTickets(req.section.id);
  const safeName = req.section.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="qrcodes-${safeName}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  for (const t of tickets) {
    archive.append(await qrLabelSvg(ticketLabel(req.section.name, t.subsection), t.uuid), {
      name: `${safeName}-${t.uuid}.svg`,
    });
  }
  await archive.finalize();
});

eventsRouter.get('/sections/:sectionId/qrcodes/print', manage, requireSectionAccess, async (req, res) => {
  const tickets = sectionTickets(req.section.id);
  const labels = await Promise.all(tickets.map(t =>
    qrLabelSvg(ticketLabel(req.section.name, t.subsection), t.uuid)));
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
