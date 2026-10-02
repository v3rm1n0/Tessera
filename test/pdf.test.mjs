import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetLayout, buildPdf, jpegInfo, PAGE_W, PAGE_H } from '../public/js/pdf.js';
import { exportPdf } from '../public/js/card-export.js';

// ---------------------------------------------------------------- helpers

/** The smallest thing that reads as a JPEG header: SOI, APP0, SOF0 with the given size, EOI. */
function tinyJpeg(width, height, components = 3, filler = []) {
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * components, 8, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let c = 1; c <= components; c++) sof.push(c, 0x11, 0);
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...filler, 0xff, 0xd9]);
}

const latin1 = bytes => Buffer.from(bytes).toString('latin1'); // string index == byte offset

/** Reads a PDF back strictly: header, xref table with exact offsets, trailer. */
function parsePdf(bytes) {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4\n%'), 'header');
  assert.ok([...bytes.slice(10, 14)].every(b => b > 127), 'a binary comment follows the header, so tools treat the file as binary');
  assert.ok(text.endsWith('\n%%EOF\n'), 'trailer end');
  const xrefAt = Number(/\nstartxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 5), 'xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt));
  const size = Number(head[1]);
  const rows = [];
  for (let i = 0; i < size; i++) {
    const row = text.slice(xrefAt + head[0].length + i * 20, xrefAt + head[0].length + (i + 1) * 20);
    assert.match(row, /^\d{10} \d{5} [nf] \n$/, `xref row ${i} is exactly 20 bytes`);
    rows.push({ offset: Number(row.slice(0, 10)), type: row[17] });
  }
  assert.deepEqual(rows[0], { offset: 0, type: 'f' });
  assert.match(text.slice(xrefAt + head[0].length + size * 20), new RegExp(`^trailer\\n<< /Size ${size} /Root 1 0 R .*>>\\nstartxref\\n${xrefAt}\\n%%EOF\\n$`, 's'));
  const objects = new Map();
  for (let n = 1; n < size; n++) {
    assert.equal(rows[n].type, 'n');
    const at = rows[n].offset;
    assert.ok(text.slice(at).startsWith(`${n} 0 obj\n`), `object ${n} is where the xref says`);
    objects.set(n, at);
  }
  return { text, objects, size };
}

/** The dictionary text and the stream bytes of an object (the stream found through /Length, not by searching). */
function readObject(pdf, bytes, n) {
  const at = pdf.objects.get(n);
  const dict = /^\d+ 0 obj\n(<<.*?>>)\n/s.exec(pdf.text.slice(at))[1];
  const length = /\/Length (\d+)/.exec(dict);
  if (!length) return { dict };
  const from = at + pdf.text.slice(at).indexOf('stream\n') + 'stream\n'.length;
  const stream = bytes.slice(from, from + Number(length[1]));
  assert.equal(pdf.text.slice(from + stream.length, from + stream.length + 'endstream\nendobj\n'.length + 1), '\nendstream\nendobj\n', 'the stream ends exactly where /Length says');
  return { dict, stream };
}

// ---------------------------------------------------------------- layout

test('six cards fit a page in reading order, inside the margins, without touching', () => {
  const boxes = sheetLayout({ count: 6 });
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every(b => b.page === 0));
  const { margin = 24 } = {};
  for (const b of boxes) {
    assert.ok(b.x >= margin - 1e-9 && b.x + b.w <= PAGE_W - margin + 1e-9, 'inside left/right margins');
    assert.ok(b.y >= margin - 1e-9 && b.y + b.h <= PAGE_H - margin + 1e-9, 'inside top/bottom margins');
    assert.ok(Math.abs(b.h / b.w - 1930 / 900) < 1e-9, 'the card keeps its proportions');
  }
  // reading order: left to right, then the next row down (PDF y grows upwards)
  assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x);
  assert.equal(boxes[0].y, boxes[2].y);
  assert.ok(boxes[3].y < boxes[0].y);
  assert.equal(boxes[3].x, boxes[0].x);
  // neighbours are a gap (12 pt) apart, never overlapping
  assert.ok(Math.abs(boxes[1].x - (boxes[0].x + boxes[0].w) - 12) < 1e-9);
  assert.ok(Math.abs(boxes[0].y - (boxes[3].y + boxes[3].h) - 12) < 1e-9);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 || a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9, `${i} and ${j} do not overlap`);
    }
  }
});

test('the page count is the count divided by six, rounded up, and every page has the same grid', () => {
  assert.deepEqual(sheetLayout({ count: 0 }), []);
  for (const [count, pages] of [[1, 1], [6, 1], [7, 2], [12, 2], [13, 3]]) {
    const boxes = sheetLayout({ count });
    assert.equal(boxes.length, count);
    assert.equal(new Set(boxes.map(b => b.page)).size, pages, `${count} cards`);
    assert.equal(Math.max(...boxes.map(b => b.page)) + 1, pages);
  }
  const [first, seventh] = [sheetLayout({ count: 7 })[0], sheetLayout({ count: 7 })[6]];
  assert.deepEqual([seventh.x, seventh.y, seventh.w, seventh.h], [first.x, first.y, first.w, first.h]);
  assert.equal(seventh.page, 1);
});

test('other grids work, and cards that would be too tall are scaled down to fit the page', () => {
  const four = sheetLayout({ count: 5, cols: 2, rows: 2 });
  assert.equal(Math.max(...four.map(b => b.page)) + 1, 2);
  const tall = sheetLayout({ count: 2, cols: 3, rows: 2, aspect: 4 });
  for (const b of tall) {
    assert.ok(b.y >= 24 - 1e-9 && b.y + b.h <= PAGE_H - 24 + 1e-9, 'fits vertically');
    assert.ok(Math.abs(b.h / b.w - 4) < 1e-9, 'still proportional');
  }
});

// ---------------------------------------------------------------- jpeg header

test('the size and colour components are read from the JPEG header', () => {
  assert.deepEqual(jpegInfo(tinyJpeg(900, 1930)), { width: 900, height: 1930, components: 3 });
  assert.deepEqual(jpegInfo(tinyJpeg(17, 300, 1)), { width: 17, height: 300, components: 1 });
  assert.throws(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /JPEG/);
  assert.throws(() => jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), /JPEG/);
});

// ---------------------------------------------------------------- the pdf

// bytes a text-based writer would damage: CR LF, NUL, high bytes, and the words that end a stream
const NASTY = new Uint8Array([0x0d, 0x0a, 0, 0xff, 0xfe, ...Buffer.from('endstream\nendobj'), 0x80, 0x0d]);

const onePage = {
  width: PAGE_W,
  height: PAGE_H,
  images: [
    { jpeg: tinyJpeg(900, 1930, 3, NASTY), pxW: 900, pxH: 1930, components: 3, x: 24, y: 400.5, w: 174.4, h: 374 },
    { jpeg: tinyJpeg(900, 1930, 3), pxW: 900, pxH: 1930, components: 3, x: 210.4, y: 400.5, w: 174.4, h: 374 },
  ],
  rects: [{ x: 24, y: 400.5, w: 174.4, h: 374 }, { x: 210.4, y: 400.5, w: 174.4, h: 374 }],
};

test('the file is well formed: header, exact cross-reference offsets, trailer', () => {
  const bytes = buildPdf([onePage, { ...onePage, images: [onePage.images[1]], rects: [] }]);
  assert.ok(bytes instanceof Uint8Array);
  const pdf = parsePdf(bytes);
  // object 0, catalog, page tree, (page + content + 2 images), (page + content + 1 image), info
  assert.equal(pdf.size, 1 + 2 + 4 + 3 + 1);
});

test('the page tree has one /Page per page, each with its size', () => {
  const bytes = buildPdf([onePage, onePage, { ...onePage, width: 300, height: 500 }]);
  const pdf = parsePdf(bytes);
  assert.equal([...pdf.text.matchAll(/\/Type \/Page\b(?!s)/g)].length, 3);
  assert.match(pdf.text, /\/Type \/Pages \/Kids \[(\d+ 0 R ?){3}\] \/Count 3/);
  assert.equal([...pdf.text.matchAll(/\/MediaBox \[0 0 595\.28 841\.89\]/g)].length, 2);
  assert.match(pdf.text, /\/MediaBox \[0 0 300 500\]/);
});

test('images are embedded as untouched DCT streams with the right length and dictionary', () => {
  const bytes = buildPdf([onePage]);
  const pdf = parsePdf(bytes);
  const images = [...pdf.objects.keys()].map(n => readObject(pdf, bytes, n)).filter(o => o.dict.includes('/Subtype /Image'));
  assert.equal(images.length, 2);
  for (const [i, image] of images.entries()) {
    assert.match(image.dict, /\/Type \/XObject \/Subtype \/Image \/Width 900 \/Height 1930 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
    assert.deepEqual([...image.stream], [...onePage.images[i].jpeg], `image ${i} is byte for byte what went in`);
  }
});

test('grey JPEGs use DeviceGray, anything else is refused', () => {
  const grey = { ...onePage, images: [{ ...onePage.images[1], jpeg: tinyJpeg(4, 4, 1), pxW: 4, pxH: 4, components: 1 }], rects: [] };
  assert.match(latin1(buildPdf([grey])), /\/ColorSpace \/DeviceGray/);
  const cmyk = { ...onePage, images: [{ ...onePage.images[1], components: 4 }], rects: [] };
  assert.throws(() => buildPdf([cmyk]), /colou?r/i);
});

test('each page draws its images at their place and cuts lines around them', () => {
  const bytes = buildPdf([onePage]);
  const pdf = parsePdf(bytes);
  const page = [...pdf.objects.keys()].map(n => ({ n, ...readObject(pdf, bytes, n) })).find(o => o.dict.includes('/Type /Page') && !o.dict.includes('/Pages'));
  const contents = Number(/\/Contents (\d+) 0 R/.exec(page.dict)[1]);
  const content = latin1(readObject(pdf, bytes, contents).stream);
  assert.match(content, /q 174\.4 0 0 374 24 400\.5 cm \/Im1 Do Q\n/);
  assert.match(content, /q 174\.4 0 0 374 210\.4 400\.5 cm \/Im2 Do Q\n/);
  assert.equal([...content.matchAll(/ re S\n/g)].length, 2, 'one cut line per card');
  assert.match(content, /24 400\.5 174\.4 374 re S\n/);
  // the names in the content are the page's resources, pointing at real image objects
  for (const name of ['Im1', 'Im2']) {
    const target = Number(new RegExp(`/${name} (\\d+) 0 R`).exec(page.dict)[1]);
    assert.match(readObject(pdf, bytes, target).dict, /\/Subtype \/Image/);
  }
});

test('numbers never come out in exponent notation, which PDF does not allow', () => {
  const page = { ...onePage, images: [{ ...onePage.images[0], x: 1e-7, y: 123456789.123456, w: 1e-9, h: 3 }], rects: [{ x: 1e-7, y: 0.0000001, w: 2, h: 3 }] };
  assert.doesNotMatch(latin1(buildPdf([page])), /\d[eE][-+]?\d/);
});

test('a PDF needs at least one page', () => {
  assert.throws(() => buildPdf([]), /page/i);
});

// ---------------------------------------------------------------- the export

const tickets = n => Array.from({ length: n }, (_, i) => ({ uuid: `u${i}`, section_id: 1, section: 'Audio', subsection_id: null, subsection: null }));
const renderJpeg = async () => tinyJpeg(900, 1930);

test('thirteen cards become three pages of up to six, each card with its cut line', async () => {
  const progress = [];
  const bytes = await exportPdf({ tickets: tickets(13), renderJpeg, onProgress: (done, total) => progress.push([done, total]) });
  const pdf = parsePdf(bytes);
  assert.equal([...pdf.text.matchAll(/\/Type \/Page\b(?!s)/g)].length, 3);
  assert.equal([...pdf.text.matchAll(/\/Subtype \/Image/g)].length, 13);
  assert.equal([...pdf.text.matchAll(/ re S\n/g)].length, 13);
  assert.equal(progress.length, 13);
  assert.deepEqual(progress.at(-1), [13, 13]);
});

test('cancelling stops the rendering with an AbortError', async () => {
  const controller = new AbortController();
  let rendered = 0;
  await assert.rejects(
    exportPdf({
      tickets: tickets(20), signal: controller.signal,
      renderJpeg: async () => { rendered++; return tinyJpeg(900, 1930); },
      onProgress: done => { if (done === 4) controller.abort(); },
    }),
    { name: 'AbortError' });
  assert.equal(rendered, 4);
});

test('something that is not a JPEG fails the export instead of making a broken file', async () => {
  await assert.rejects(exportPdf({ tickets: tickets(2), renderJpeg: async () => new Uint8Array([1, 2, 3]) }), /JPEG/);
});
