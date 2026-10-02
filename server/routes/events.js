import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { db, pickSectionColor } from '../db.js';
import { requireRole, requireEventAccess, requireSectionAccess, canAccessEvent } from '../auth.js';
import { HttpError } from '../errors.js';
import { uniqueSheetName } from '../xlsx.js';
import { requireName } from '../validate.js';

/** Event Admin functionality: sections, UUIDs and QR codes are managed exclusively by the event's admins. */
export const eventsRouter = Router();
const manage = requireRole('EVENT_ADMIN');

eventsRouter.patch('/events/:eventId', manage, requireEventAccess, (req, res) => {
  const resetTime = req.body?.reset_time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(resetTime || '')) {
    throw new HttpError(400, 'RESET_TIME_INVALID');
  }
  db.prepare('UPDATE events SET reset_time = ? WHERE id = ?').run(resetTime, req.event.id);
  res.json({ ...req.event, reset_time: resetTime });
});

const COLOR_RE = /^#[0-9a-f]{6}$/i;

eventsRouter.post('/events/:eventId/sections', manage, requireEventAccess, (req, res) => {
  const name = requireName(req.body?.name);
  const custom = req.body?.color;
  if (custom !== undefined && !COLOR_RE.test(custom)) {
    throw new HttpError(400, 'COLOR_INVALID');
  }
  const color = custom || pickSectionColor(req.event.id);
  try {
    const info = db.prepare('INSERT INTO sections (event_id, name, color) VALUES (?, ?, ?)')
      .run(req.event.id, name, color);
    res.status(201).json({ id: Number(info.lastInsertRowid), event_id: req.event.id, name, color });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw new HttpError(409, 'SECTION_EXISTS');
    }
    throw e;
  }
});

eventsRouter.patch('/sections/:sectionId', manage, requireSectionAccess, (req, res) => {
  const color = req.body?.color;
  if (color !== undefined) {
    if (!COLOR_RE.test(color)) {
      throw new HttpError(400, 'COLOR_INVALID');
    }
    db.prepare('UPDATE sections SET color = ? WHERE id = ?').run(color, req.section.id);
  }
  res.json(db.prepare('SELECT * FROM sections WHERE id = ?').get(req.section.id));
});

eventsRouter.delete('/sections/:sectionId', manage, requireSectionAccess, (req, res) => {
  db.prepare('DELETE FROM sections WHERE id = ?').run(req.section.id);
  res.json({ ok: true });
});

eventsRouter.post('/sections/:sectionId/subsections', manage, requireSectionAccess, (req, res) => {
  const name = requireName(req.body?.name);
  try {
    const info = db.prepare('INSERT INTO subsections (section_id, name) VALUES (?, ?)')
      .run(req.section.id, name);
    res.status(201).json({ id: Number(info.lastInsertRowid), section_id: req.section.id, name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw new HttpError(409, 'SUBSECTION_EXISTS');
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
  if (!sub) throw new HttpError(404, 'SUBSECTION_NOT_FOUND');
  if (!canAccessEvent(req.user, sub.event_id)) throw new HttpError(403, 'NOT_AUTHORIZED_EVENT');
  // the codes of a subsection go with it (their scans follow via ON DELETE CASCADE); without this
  // they would silently turn into section-level codes under a different label
  db.exec('BEGIN');
  try {
    const { changes } = db.prepare('DELETE FROM tickets WHERE subsection_id = ?').run(sub.id);
    db.prepare('DELETE FROM subsections WHERE id = ?').run(sub.id);
    db.exec('COMMIT');
    res.json({ ok: true, deleted_tickets: Number(changes) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

eventsRouter.post('/sections/:sectionId/tickets', manage, requireSectionAccess, (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new HttpError(400, 'COUNT_INVALID');
  }
  let subsectionId = null;
  if (req.body?.subsection_id != null) {
    const sub = db.prepare('SELECT id FROM subsections WHERE id = ? AND section_id = ?')
      .get(Number(req.body.subsection_id), req.section.id);
    if (!sub) throw new HttpError(400, 'SUBSECTION_MISMATCH');
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

// admission card: defined once per event (title, text, backdrop); cards are
// composited client-side on a <canvas>, so the server only stores the config
const CARD_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

eventsRouter.get('/events/:eventId/card', manage, requireEventAccess, (req, res) => {
  const e = db.prepare(
    'SELECT card_title, card_text, card_backdrop_mime FROM events WHERE id = ?'
  ).get(req.event.id);
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets t
    JOIN sections s ON s.id = t.section_id WHERE s.event_id = ?
  `).get(req.event.id).n;
  // first section/subsection drives the live preview's color and label
  const first = db.prepare(`
    SELECT s.name AS section, s.color, sub.name AS subsection
    FROM sections s LEFT JOIN subsections sub ON sub.section_id = s.id
    WHERE s.event_id = ? ORDER BY s.name, sub.name LIMIT 1
  `).get(req.event.id);
  res.json({
    event: req.event.name,
    title: e.card_title,
    text: e.card_text,
    has_backdrop: !!e.card_backdrop_mime,
    total_tickets: total,
    sample: first
      ? { color: first.color, label: first.subsection ? `${first.section} – ${first.subsection}` : first.section }
      : null,
  });
});

eventsRouter.put('/events/:eventId/card', manage, requireEventAccess, (req, res) => {
  const title = String(req.body?.title ?? '').slice(0, 200);
  const text = String(req.body?.text ?? '').slice(0, 4000);
  db.prepare('UPDATE events SET card_title = ?, card_text = ? WHERE id = ?')
    .run(title, text, req.event.id);
  res.json({ ok: true });
});

eventsRouter.post('/events/:eventId/card/backdrop',
  manage, requireEventAccess,
  express.raw({ type: CARD_MIMES, limit: '8mb' }),
  (req, res) => {
    const mime = req.headers['content-type'];
    if (!CARD_MIMES.includes(mime)) {
      throw new HttpError(400, 'IMAGE_TYPE_INVALID');
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(400, 'IMAGE_MISSING');
    }
    db.prepare('UPDATE events SET card_backdrop = ?, card_backdrop_mime = ? WHERE id = ?')
      .run(req.body, mime, req.event.id);
    res.status(201).json({ ok: true });
  });

eventsRouter.get('/events/:eventId/card/backdrop', manage, requireEventAccess, (req, res) => {
  const e = db.prepare('SELECT card_backdrop, card_backdrop_mime FROM events WHERE id = ?')
    .get(req.event.id);
  if (!e.card_backdrop) throw new HttpError(404, 'NO_BACKDROP');
  res.setHeader('Content-Type', e.card_backdrop_mime);
  res.setHeader('Cache-Control', 'no-store');
  res.end(Buffer.from(e.card_backdrop));
});

eventsRouter.delete('/events/:eventId/card/backdrop', manage, requireEventAccess, (req, res) => {
  db.prepare('UPDATE events SET card_backdrop = NULL, card_backdrop_mime = NULL WHERE id = ?')
    .run(req.event.id);
  res.json({ ok: true });
});

/** Flat ticket list (with section color + label parts) for bulk card export. */
eventsRouter.get('/events/:eventId/card/tickets', manage, requireEventAccess, (req, res) => {
  res.json(db.prepare(`
    SELECT t.uuid, s.name AS section, s.color, sub.name AS subsection
    FROM tickets t
    JOIN sections s ON s.id = t.section_id
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE s.event_id = ?
    ORDER BY s.name, sub.name, t.created_at
  `).all(req.event.id));
});

/** One UUID-list workbook per export folder (grouped by section/subsection), returned as base64 for the client to place. */
eventsRouter.get('/events/:eventId/card/xlsx', manage, requireEventAccess, async (req, res) => {
  const rows = db.prepare(`
    SELECT t.uuid, s.id AS section_id, s.name AS section,
           t.subsection_id, sub.name AS subsection
    FROM tickets t
    JOIN sections s ON s.id = t.section_id
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE s.event_id = ?
    ORDER BY s.name, sub.name, t.created_at
  `).all(req.event.id);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.section_id}|${r.subsection_id ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, { section: r.section, subsection: r.subsection, uuids: [] });
    }
    groups.get(key).uuids.push(r.uuid);
  }

  const out = [];
  for (const g of groups.values()) {
    const label = g.subsection ? `${g.section} – ${g.subsection}` : g.section;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('UUIDs');
    sheet.columns = [
      { header: 'Section', key: 'label', width: 34 },
      { header: 'UUID', key: 'uuid', width: 40 },
      { header: 'Name (recipient)', key: 'name', width: 30 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const uuid of g.uuids) sheet.addRow({ label, uuid, name: '' });
    const buf = await wb.xlsx.writeBuffer();
    out.push({ section: g.section, subsection: g.subsection, base64: Buffer.from(buf).toString('base64') });
  }
  res.json({ groups: out });
});

eventsRouter.get('/events/:eventId/tickets.xlsx', manage, requireEventAccess, async (req, res) => {
  const sections = db.prepare('SELECT * FROM sections WHERE event_id = ? ORDER BY name')
    .all(req.event.id);
  const wb = new ExcelJS.Workbook();
  const usedSheetNames = new Set(['history']);
  for (const section of sections) {
    const sheet = wb.addWorksheet(uniqueSheetName(section.name, usedSheetNames));
    sheet.columns = [
      { header: 'Section', key: 'section', width: 30 },
      { header: 'Subsection', key: 'subsection', width: 30 },
      { header: 'UUID', key: 'uuid', width: 40 },
      { header: 'Created', key: 'created', width: 22 },
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
  if (sections.length === 0) wb.addWorksheet('Empty');
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="uuids-event-${req.event.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
