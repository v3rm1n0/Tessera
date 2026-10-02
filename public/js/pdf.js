// A small PDF writer for print sheets: pages of JPEG images plus thin rectangles (cut lines).
// No dependencies; everything is bytes, so image data is never touched by text encoding.

export const PAGE_W = 595.28; // A4 in points
export const PAGE_H = 841.89;

/**
 * Where each of `count` cards goes: a grid of `cols` x `rows` per page, centred, reading order (left to
 * right, then down), as { page, x, y, w, h } with x/y the lower-left corner in PDF coordinates. Cards
 * keep their `aspect` (height / width); when the grid would be taller than the page they shrink.
 */
export function sheetLayout({ count, cols = 3, rows = 2, pageW = PAGE_W, pageH = PAGE_H, margin = 24, gap = 12, aspect = 1930 / 900 }) {
  let w = (pageW - 2 * margin - (cols - 1) * gap) / cols;
  let h = w * aspect;
  const maxH = (pageH - 2 * margin - (rows - 1) * gap) / rows;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  const left = (pageW - (cols * w + (cols - 1) * gap)) / 2;
  const top = pageH - (pageH - (rows * h + (rows - 1) * gap)) / 2;
  return Array.from({ length: count }, (_, i) => {
    const slot = i % (cols * rows);
    const row = Math.floor(slot / cols);
    return { page: Math.floor(i / (cols * rows)), x: left + (slot % cols) * (w + gap), y: top - (row + 1) * h - row * gap, w, h };
  });
}

/** Width, height and number of colour components, read from a JPEG's start-of-frame header. */
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG image');
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }                                       // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // markers without a length
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  throw new Error('Not a JPEG image: no frame header found');
}

const encoder = new TextEncoder();
const num = n => String(Number(n.toFixed(3))); // PDF numbers have no exponent notation

/**
 * The bytes of a PDF with the given pages: { width, height, images: [{ jpeg, pxW, pxH, components, x, y, w, h }],
 * rects: [{ x, y, w, h }] } (points; rects are drawn as thin grey outlines, the cut lines).
 */
export function buildPdf(pages) {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');

  const chunks = [];
  let length = 0;
  const push = bytes => { chunks.push(bytes); length += bytes.length; };
  const text = s => push(encoder.encode(s));

  // object numbers: 1 catalog, 2 page tree, then per page its page, its content and its images; the info last
  let next = 3;
  const plan = pages.map(page => ({ page, id: next++, contentId: next++, imageIds: page.images.map(() => next++) }));
  const infoId = next++;
  const offsets = [];

  const object = (id, dict, stream) => {
    offsets[id] = length;
    text(`${id} 0 obj\n${dict}\n`);
    if (stream) {
      text('stream\n');
      push(stream);
      text('\nendstream\n');
    }
    text('endobj\n');
  };

  text('%PDF-1.4\n');
  push(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)); // a comment of high bytes: tools treat the file as binary
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${plan.map(p => `${p.id} 0 R`).join(' ')}] /Count ${plan.length} >>`);

  for (const { page, id, contentId, imageIds } of plan) {
    const xobjects = imageIds.map((imageId, i) => `/Im${i + 1} ${imageId} 0 R`).join(' ');
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] `
      + `/Resources << ${xobjects ? `/XObject << ${xobjects} >> ` : ''}>> /Contents ${contentId} 0 R >>`);

    const content = encoder.encode([
      ...page.images.map((im, i) => `q ${num(im.w)} 0 0 ${num(im.h)} ${num(im.x)} ${num(im.y)} cm /Im${i + 1} Do Q\n`),
      page.rects.length ? '0.55 G 0.5 w\n' : '',
      ...page.rects.map(r => `${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re S\n`),
    ].join(''));
    object(contentId, `<< /Length ${content.length} >>`, content);

    page.images.forEach((im, i) => {
      const space = { 1: 'DeviceGray', 3: 'DeviceRGB' }[im.components ?? 3];
      if (!space) throw new Error(`Unsupported JPEG colour space (${im.components} components)`);
      object(imageIds[i], `<< /Type /XObject /Subtype /Image /Width ${im.pxW} /Height ${im.pxH} /ColorSpace /${space} `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`, im.jpeg);
    });
  }
  object(infoId, '<< /Producer (Tessera) >>');

  const xrefAt = length;
  text(`xref\n0 ${infoId + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= infoId; id++) text(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
