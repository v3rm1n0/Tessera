import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// expose the vendored classic-script QR generator as window.qrcode
const require = createRequire(import.meta.url);
global.window = { qrcode: require('../node_modules/qrcode-generator/dist/qrcode.js') };

const { drawCard, contrastColor, qrMatrix, boldWords, shortCode, CARD_W, CARD_H } =
  await import('../public/js/card-render.js');

/** Minimal 2D-context stub that records draw calls and swallows property sets. */
function stubCtx() {
  const calls = { fillText: 0, fillRect: 0, drawImage: 0, texts: [] };
  const target = {
    calls,
    measureText: s => ({ width: s.length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, beginPath() {}, moveTo() {}, arcTo() {},
    closePath() {}, fill() {}, clip() {}, rect() {},
    fillRect() { calls.fillRect++; },
    fillText(text, x, y) { calls.fillText++; calls.texts.push({ text, x, y }); },
    drawImage() { calls.drawImage++; },
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : undefined),
    set: (t, p, v) => { if (p === 'font') (calls.fonts ??= []).push(v); return true; },
  });
}

test('contrastColor picks readable ink for the background', () => {
  assert.equal(contrastColor('#ffffff'), '#141414');
  assert.equal(contrastColor('#f5d90a'), '#141414'); // bright yellow → dark ink
  assert.equal(contrastColor('#000000'), '#ffffff');
  assert.equal(contrastColor('#4f9cf5'), '#ffffff');
});

test('qrMatrix builds a square boolean matrix', () => {
  const m = qrMatrix('550e8400-e29b-41d4-a716-446655440000');
  assert.ok(m.length >= 21);
  assert.equal(m.length, m[0].length);
  assert.equal(typeof m[0][0], 'boolean');
});

test('drawCard renders without a backdrop (text + QR drawn, no image)', () => {
  const ctx = stubCtx();
  drawCard(ctx, {
    color: '#2dd4a7', title: 'TESSERA-AUSWEIS',
    text: 'Liebe Schwester, lieber Bruder!\nVielen Dank für deinen Dienst.',
    label: 'Ordnungsdienst – Innenraum Ordner',
    backdropImg: null, matrix: qrMatrix('abc'),
  });
  assert.equal(ctx.calls.drawImage, 0);
  assert.ok(ctx.calls.fillText >= 3);   // title + body lines + label
  assert.ok(ctx.calls.fillRect > 50);   // background + QR modules
});

test('boldWords toggles bold on ** markers', () => {
  assert.deepEqual(boldWords('a **b c** d'), [
    { text: 'a', bold: false },
    { text: 'b', bold: true },
    { text: 'c', bold: true },
    { text: 'd', bold: false },
  ]);
  assert.deepEqual(boldWords('plain text'), [
    { text: 'plain', bold: false }, { text: 'text', bold: false },
  ]);
});

test('drawCard renders a 700-weight run for **bold** body text', () => {
  const plain = stubCtx();
  drawCard(plain, {
    color: '#4f9cf5', title: '', text: 'nur normaler text hier ganz simpel',
    label: '', backdropImg: null, matrix: null,
  });
  const bold = stubCtx();
  drawCard(bold, {
    color: '#4f9cf5', title: '', text: 'ein **fetter** teil im text',
    label: '', backdropImg: null, matrix: null,
  });
  const boldRuns = f => (f.calls.fonts || []).filter(x => x.startsWith('700 30px')).length;
  // no title/label/QR here, so a 30px-700 font only appears from bold body words
  assert.equal(boldRuns(plain), 0);
  assert.ok(boldRuns(bold) >= 1);
});

test('drawCard draws the backdrop image when provided', () => {
  const ctx = stubCtx();
  drawCard(ctx, {
    color: '#c98850', title: 'TESSERA-AUSWEIS', text: 'Text',
    label: 'Audio Video', backdropImg: { width: 1200, height: 1600 },
    matrix: qrMatrix('abc'),
  });
  assert.equal(ctx.calls.drawImage, 1);
});

test('card dimensions are exported', () => {
  assert.equal(CARD_W, 900);
  assert.ok(CARD_H > CARD_W);
});

test('shortCode is the first 12 hex digits of the uuid in groups of four', () => {
  assert.equal(shortCode('550e8400-e29b-41d4-a716-446655440000'), '550E-8400-E29B');
  assert.equal(shortCode('550E8400-E29B-41D4-A716-446655440000'), '550E-8400-E29B');
  assert.equal(shortCode(''), '');
  assert.equal(shortCode(undefined), '');
  assert.equal(shortCode('not a uuid'), '');
});

test('the short code has exactly as many digits as the server needs to find a ticket', async () => {
  const { MIN_PREFIX_DIGITS, parseCodeInput } = await import('../server/codes.js');
  const code = shortCode('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(code.replaceAll('-', '').length, MIN_PREFIX_DIGITS);
  assert.deepEqual(parseCodeInput(code), { kind: 'prefix', prefix: '550e8400-e29b' });
});

const CARD = { color: '#2dd4a7', title: 'T', text: 'Text', label: 'Audio Video', backdropImg: null };

test('drawCard prints the short code as one more line below the label, inside the card', () => {
  const without = stubCtx();
  drawCard(without, { ...CARD, matrix: qrMatrix('abc') });
  const withCode = stubCtx();
  drawCard(withCode, { ...CARD, matrix: qrMatrix('abc'), code: '550E-8400-E29B' });

  assert.equal(withCode.calls.fillText, without.calls.fillText + 1);
  const label = withCode.calls.texts.find(x => x.text === 'Audio Video');
  const code = withCode.calls.texts.find(x => x.text === '550E-8400-E29B');
  assert.ok(code, 'the code is drawn');
  assert.ok(code.y > label.y, 'below the label');
  assert.equal(code.x, label.x, 'centred under the QR like the label');
  for (const { text, y } of withCode.calls.texts) assert.ok(y > 0 && y + 16 <= CARD_H, `"${text}" stays inside the card`);
});

test('the QR moves up to make room for the code line, so the bottom margin stays the same', () => {
  const without = stubCtx();
  drawCard(without, { ...CARD, matrix: qrMatrix('abc') });
  const withCode = stubCtx();
  drawCard(withCode, { ...CARD, matrix: qrMatrix('abc'), code: '550E-8400-E29B' });
  const labelY = ctx => ctx.calls.texts.find(x => x.text === 'Audio Video').y;
  assert.ok(labelY(withCode) < labelY(without), 'the QR and its label sit higher when a code line follows');
});

test('a long code is shrunk to the width of the QR block', () => {
  const ctx = stubCtx();
  drawCard(ctx, { ...CARD, matrix: qrMatrix('abc'), code: '0123456789ABCDEF0123456789ABCDEF0123456789' });
  const sizes = (ctx.calls.fonts || []).map(f => Number(/(\d+)px/.exec(f)?.[1])).filter(Boolean);
  assert.ok(sizes.some(px => px < 30), 'the font was reduced until the text fit');
});
