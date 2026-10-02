import ExcelJS from 'exceljs';
import { HttpError } from './errors.js';
import { normalizeUuid } from './codes.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// browsers (notably on Windows) label .csv files with a few different types
const CSV_MIMES = ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'];
export const IMPORT_TYPES = [XLSX_MIME, ...CSV_MIMES];

const MAX_NAME = 100;
const HEADER_SCAN_ROWS = 10; // how far down a header row may be
const UUID_SCAN_ROWS = 50;   // rows looked at to find the uuid column of a sheet without header
const NAME_HEADER = /name|empf|recipient|inhaber|holder/i;

/** Rows of cells from delimited text with RFC 4180 quoting (quoted fields may hold delimiters, quotes and line breaks). */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** CSV with the delimiter guessed from the first line: comma, semicolon (German Excel) or tab. */
export function parseCsv(text) {
  const source = text.replace(/^﻿/, '');
  const first = source.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  let delimiter = ',';
  let best = 0;
  for (const candidate of [',', ';', '\t']) {
    const n = first.split(candidate).length - 1;
    if (n > best) { best = n; delimiter = candidate; }
  }
  return parseDelimited(source, delimiter);
}

/** One table (array of rows of strings) per worksheet. */
async function xlsxTables(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new HttpError(400, 'IMPORT_INVALID');
  }
  const tables = [];
  workbook.eachSheet(sheet => {
    const rows = [];
    sheet.eachRow(row => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = String(cell.text ?? ''); });
      rows.push(Array.from(cells, value => value ?? ''));
    });
    tables.push(rows);
  });
  return tables;
}

/** Finds the uuid and name columns of a table and returns its { uuid, name } rows. */
function holderPairs(rows) {
  let uuidCol = -1;
  let nameCol = -1;
  let first = 0;
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const col = rows[r].findIndex(cell => /^\s*uuid\s*$/i.test(cell));
    if (col >= 0) {
      uuidCol = col;
      nameCol = rows[r].findIndex((cell, i) => i !== col && NAME_HEADER.test(cell));
      first = r + 1;
      break;
    }
  }
  if (uuidCol < 0) {
    // no header: the column that holds the most uuids is the code column
    const counts = [];
    for (const row of rows.slice(0, UUID_SCAN_ROWS)) {
      row.forEach((cell, i) => { if (normalizeUuid(cell)) counts[i] = (counts[i] ?? 0) + 1; });
    }
    let bestCount = 0;
    counts.forEach((n, i) => { if (n > bestCount) { bestCount = n; uuidCol = i; } });
    if (uuidCol < 0) return [];
  }
  if (nameCol < 0) nameCol = uuidCol + 1;

  const pairs = [];
  for (const row of rows.slice(first)) {
    const uuid = normalizeUuid(row[uuidCol]);
    if (uuid) pairs.push({ uuid, name: String(row[nameCol] ?? '').trim().slice(0, MAX_NAME) });
  }
  return pairs;
}

/**
 * Reads a filled-in sheet (Excel or CSV) into { uuid, name } rows. Works with the sheets the app
 * exports, in either language, and with plain two-column files. Names are trimmed and cut to
 * 100 characters; rows without a uuid are ignored.
 */
export async function parseHolderRows(buffer, contentType) {
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  let tables;
  if (type === XLSX_MIME) tables = await xlsxTables(buffer);
  else if (CSV_MIMES.includes(type)) tables = [parseCsv(buffer.toString('utf8'))];
  else throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const pairs = tables.flatMap(holderPairs);
  if (pairs.length === 0) throw new HttpError(400, 'IMPORT_EMPTY');
  return pairs;
}
