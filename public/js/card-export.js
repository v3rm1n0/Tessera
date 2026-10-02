// Builds the admission-card export: which cards, in which folders, with progress and cancel.
// Free of the DOM (the caller supplies the renderer and JSZip), so it can be tested in node.
import { CARD_W, CARD_H } from './card-render.js';
import { sheetLayout, buildPdf, jpegInfo, PAGE_W, PAGE_H } from './pdf.js';

/** A name that is safe as a folder or file name on every system. */
export const safeName = name => String(name ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '_') || '_';

/** Map keys of `folderNames`: a section's folder, and a subsection's folder inside it. */
export const sectionKey = sectionId => String(sectionId);
export const subsectionKey = (sectionId, subsectionId) => `${sectionId}/${subsectionId}`;

/**
 * The folder name of every section and subsection among `tickets`. Two names that end up the same
 * (`Crew 1` and `Crew_1`, or `Crew` and `crew`, which are one folder on macOS and Windows) get a
 * numbered suffix; siblings are compared, so the same subsection name in two sections is fine.
 */
export function folderNames(tickets) {
  const names = new Map();
  const taken = new Map(); // parent key -> lower-cased names in use there
  const claim = (parent, key, wanted) => {
    if (names.has(key)) return;
    if (!taken.has(parent)) taken.set(parent, new Set());
    const used = taken.get(parent);
    let candidate = wanted;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${wanted}_${n}`;
    used.add(candidate.toLowerCase());
    names.set(key, candidate);
  };
  for (const tk of tickets) {
    claim('', sectionKey(tk.section_id), safeName(tk.section));
    if (tk.subsection_id != null) {
      claim(sectionKey(tk.section_id), subsectionKey(tk.section_id, tk.subsection_id), safeName(tk.subsection));
    }
  }
  return names;
}

/**
 * Whether a ticket (or xlsx group) belongs to `scope`: { section_id? } is a whole section including
 * its subsections, { section_id, subsection_id } one subsection, and subsection_id null means the
 * codes that sit directly in the section.
 */
export function matchesScope(item, { section_id: sectionId, subsection_id: subsectionId } = {}) {
  if (sectionId != null && item.section_id !== sectionId) return false;
  if (subsectionId !== undefined && item.subsection_id !== subsectionId) return false;
  return true;
}

export const filterTickets = (tickets, scope) => tickets.filter(tk => matchesScope(tk, scope));

/**
 * The choices for what to export, from the groups `GET /card` lists: every section with its total, its
 * subsections, and (when it has both) the codes directly in it. Each is { scope, count, section,
 * subsection } and the direct-codes choice carries `direct: true`.
 */
export function scopeOptions(groups) {
  const bySection = new Map();
  for (const group of groups) {
    if (!bySection.has(group.section_id)) bySection.set(group.section_id, []);
    bySection.get(group.section_id).push(group);
  }
  const options = [];
  for (const [sectionId, list] of bySection) {
    const { section } = list[0];
    const subsections = list.filter(g => g.subsection_id !== null);
    const direct = list.find(g => g.subsection_id === null);
    options.push({ scope: { section_id: sectionId }, count: list.reduce((n, g) => n + g.count, 0), section, subsection: null });
    for (const g of subsections) {
      options.push({ scope: { section_id: sectionId, subsection_id: g.subsection_id }, count: g.count, section, subsection: g.subsection });
    }
    if (direct && subsections.length > 0) {
      options.push({ scope: { section_id: sectionId, subsection_id: null }, count: direct.count, section, subsection: null, direct: true });
    }
  }
  return options;
}

const cancelled = () => new DOMException('The export was cancelled.', 'AbortError');
const breathe = () => new Promise(resolve => setTimeout(resolve));

/**
 * Renders every ticket with `renderCard(ticket) -> PNG bytes/Blob` into Section/Subsection/uuid.png and
 * resolves to the finished archive (a Blob where the browser has one). `signal` cancels between cards
 * (and while packing) with an AbortError; `onProgress(done, total)` follows every card and `onPack()`
 * announces the packing. `xlsxGroups`
 * ({ section_id, subsection_id, base64 }) are the per-folder code lists, placed as UUIDs.xlsx in the
 * folders that are part of the export.
 */
export async function exportZip({ tickets, renderCard, JSZip, signal, onProgress = () => {}, onPack = () => {}, xlsxGroups = [] }) {
  const stop = () => { if (signal?.aborted) throw cancelled(); };
  const names = folderNames(tickets);
  const zip = new JSZip();
  const folderOf = item => {
    const section = zip.folder(names.get(sectionKey(item.section_id)));
    return item.subsection_id == null ? section : section.folder(names.get(subsectionKey(item.section_id, item.subsection_id)));
  };

  for (let i = 0; i < tickets.length; i++) {
    stop();
    const png = await renderCard(tickets[i]);
    stop();
    folderOf(tickets[i]).file(`${tickets[i].uuid}.png`, png);
    onProgress(i + 1, tickets.length);
    if (i % 8 === 7) await breathe(); // keeps the page responsive: progress text, the Cancel button
  }

  // a list goes in only when at least one of its codes is part of the export
  const exported = new Set(tickets.map(tk => `${tk.section_id}|${tk.subsection_id ?? ''}`));
  for (const group of xlsxGroups) {
    if (exported.has(`${group.section_id}|${group.subsection_id ?? ''}`)) {
      folderOf(group).file('UUIDs.xlsx', group.base64, { base64: true });
    }
  }

  stop();
  onPack();
  const archive = await zip.generateAsync({ type: typeof Blob === 'undefined' ? 'uint8array' : 'blob' });
  stop();
  return archive;
}

/**
 * Print sheets: every ticket rendered with `renderJpeg(ticket) -> JPEG bytes`, six cards to an A4 page with a
 * cut line around each, as the bytes of one PDF. Cancel and progress work as in `exportZip`.
 */
export async function exportPdf({ tickets, renderJpeg, signal, onProgress = () => {} }) {
  const stop = () => { if (signal?.aborted) throw cancelled(); };
  const layout = sheetLayout({ count: tickets.length, aspect: CARD_H / CARD_W });
  const pages = [];

  for (let i = 0; i < tickets.length; i++) {
    stop();
    const jpeg = await renderJpeg(tickets[i]);
    stop();
    const { width, height, components } = jpegInfo(jpeg);
    const { page, x, y, w, h } = layout[i];
    pages[page] ??= { width: PAGE_W, height: PAGE_H, images: [], rects: [] };
    pages[page].images.push({ jpeg, pxW: width, pxH: height, components, x, y, w, h });
    pages[page].rects.push({ x, y, w, h });
    onProgress(i + 1, tickets.length);
    if (i % 8 === 7) await breathe();
  }

  stop();
  return buildPdf(pages);
}
