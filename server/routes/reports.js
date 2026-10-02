import { Router } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../db.js';
import { requireRole, requireEventAccess } from '../auth.js';
import { HttpError } from '../errors.js';
import { parseCodeInput } from '../codes.js';
import { dayBoundaries, wallClockDate } from '../time.js';
import { excelHeaders, normalizeLang, resultLabel } from '../i18n.js';

/** Scan log, code lookup and attendance export for event admins. */
export const reportsRouter = Router();
const manage = requireRole('EVENT_ADMIN');

const DAY_MS = 86_400_000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const LOOKUP_HISTORY = 100;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SCAN_COLUMNS = `
  sc.id, sc.scanned_at AS at, sc.result, sc.scan_number, sc.ticket_uuid AS uuid,
  s.name AS section, sub.name AS subsection, t.holder, u.username AS scanner, sc.voided_at`;
const SCAN_FROM = `
  FROM scans sc
  JOIN sections s ON s.id = sc.section_id
  JOIN tickets t ON t.uuid = sc.ticket_uuid
  LEFT JOIN subsections sub ON sub.id = t.subsection_id
  LEFT JOIN users u ON u.id = sc.scanned_by`;

/** The WHERE clause shared by the log and the export: event, result, search text and day window. */
function scanFilters(req) {
  const where = ['s.event_id = ?'];
  const params = [req.event.id];
  if (req.query.result === 'OK' || req.query.result === 'DOUBLE') {
    where.push('sc.result = ?');
    params.push(req.query.result);
  }
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(sc.ticket_uuid LIKE ? ESCAPE '\\' OR lower(t.holder) LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  let window = null;
  const day = Number(req.query.day);
  if (req.query.day !== undefined && req.query.day !== '' && Number.isFinite(day)) {
    // any instant selects the event day that contains it
    const [from, to] = dayBoundaries(req.event.reset_time, req.event.timezone, day, day + 2 * DAY_MS);
    where.push('sc.scanned_at >= ? AND sc.scanned_at < ?');
    params.push(from, to);
    window = { from, to };
  }
  return { where: where.join(' AND '), params, window };
}

reportsRouter.get('/events/:eventId/scans', manage, requireEventAccess, (req, res) => {
  const { where, params } = scanFilters(req);
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || DEFAULT_PAGE, 1), MAX_PAGE);
  const before = Math.trunc(Number(req.query.before));
  const paged = Number.isInteger(before) && before > 0;
  const rows = db.prepare(`
    SELECT ${SCAN_COLUMNS} ${SCAN_FROM}
    WHERE ${where}${paged ? ' AND sc.id < ?' : ''}
    ORDER BY sc.id DESC LIMIT ?
  `).all(...params, ...(paged ? [before] : []), limit + 1);
  const items = rows.slice(0, limit);
  res.json({ items, next_before: rows.length > limit ? items.at(-1).id : null });
});

/** One code (full uuid or the start of one) among the events of the caller, with its scan history. */
reportsRouter.get('/tickets/:code', manage, (req, res) => {
  const parsed = parseCodeInput(req.params.code);
  if (!parsed) throw new HttpError(400, 'INVALID_CODE');
  const matches = db.prepare(`
    SELECT t.uuid, s.event_id, t.section_id, s.name AS section, s.color, sub.name AS subsection,
           t.holder, t.revoked_at, t.created_at
    FROM tickets t
    JOIN sections s ON s.id = t.section_id
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE ${parsed.kind === 'full' ? 't.uuid = ?' : "t.uuid LIKE ? || '%'"}
      AND s.event_id IN (SELECT event_id FROM event_assignments WHERE user_id = ?)
    LIMIT 2
  `).all(parsed.kind === 'full' ? parsed.uuid : parsed.prefix, req.user.id);
  if (matches.length === 0) throw new HttpError(404, 'TICKET_NOT_FOUND');
  if (matches.length > 1) throw new HttpError(409, 'CODE_AMBIGUOUS');

  const ticket = matches[0];
  const scans = db.prepare(`
    SELECT sc.id, sc.scanned_at AS at, sc.result, sc.scan_number, u.username AS scanner, sc.voided_at
    FROM scans sc LEFT JOIN users u ON u.id = sc.scanned_by
    WHERE sc.ticket_uuid = ? ORDER BY sc.id DESC LIMIT ?
  `).all(ticket.uuid, LOOKUP_HISTORY);
  res.json({ ticket, scans });
});

const ymd = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined }).format(new Date(ms));

/** Attendance sheet (oldest scan first), streamed so large events do not have to fit in memory. */
reportsRouter.get('/events/:eventId/scans.xlsx', manage, requireEventAccess, async (req, res) => {
  const lang = normalizeLang(req.query.lang);
  const { where, params, window } = scanFilters(req);
  const zone = req.event.timezone;
  const dayPart = window ? `-${ymd(window.from, zone)}` : '';
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="scans-event-${req.event.id}${dayPart}.xlsx"`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const sheet = workbook.addWorksheet('Scans');
  const widths = [21, 24, 24, 38, 26, 12, 10, 18, 21];
  sheet.columns = excelHeaders(lang, 'scans').map((header, i) => ({ header, width: widths[i] }));
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.getColumn(9).numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.getRow(1).font = { bold: true };

  const rows = db.prepare(`SELECT ${SCAN_COLUMNS} ${SCAN_FROM} WHERE ${where} ORDER BY sc.id ASC`).iterate(...params);
  for (const r of rows) {
    sheet.addRow([
      wallClockDate(r.at, zone), r.section, r.subsection ?? '', r.uuid, r.holder, resultLabel(lang, r.result),
      r.scan_number ?? '', r.scanner ?? '', r.voided_at ? wallClockDate(r.voided_at, zone) : '',
    ]).commit();
  }
  await sheet.commit();
  await workbook.commit();
});
