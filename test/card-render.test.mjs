import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// expose the vendored classic-script QR generator as window.qrcode
const require = createRequire(import.meta.url);
global.window = { qrcode: require('../node_modules/qrcode-generator/dist/qrcode.js') };

const { drawCard, contrastColor, qrMatrix, CARD_W, CARD_H } =
  await import('../public/js/card-render.js');

/** Minimal 2D-context stub that records draw calls and swallows property sets. */
function stubCtx() {
  const calls = { fillText: 0, fillRect: 0, drawImage: 0 };
  const target = {
    calls,
    measureText: s => ({ width: s.length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, beginPath() {}, moveTo() {}, arcTo() {},
    closePath() {}, fill() {}, clip() {}, rect() {},
    fillRect() { calls.fillRect++; },
    fillText() { calls.fillText++; },
    drawImage() { calls.drawImage++; },
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : undefined),
    set: () => true, // ignore fillStyle/font/shadow/textAlign/...
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
    color: '#2dd4a7', title: 'VOREINLASS-AUSWEIS',
    text: 'Liebe Schwester, lieber Bruder!\nVielen Dank für deinen Dienst.',
    label: 'Ordnungsdienst – Innenraum Ordner',
    backdropImg: null, matrix: qrMatrix('abc'),
  });
  assert.equal(ctx.calls.drawImage, 0);
  assert.ok(ctx.calls.fillText >= 3);   // title + body lines + label
  assert.ok(ctx.calls.fillRect > 50);   // background + QR modules
});

test('drawCard draws the backdrop image when provided', () => {
  const ctx = stubCtx();
  drawCard(ctx, {
    color: '#c98850', title: 'VOREINLASS-AUSWEIS', text: 'Text',
    label: 'Audio Video', backdropImg: { width: 1200, height: 1600 },
    matrix: qrMatrix('abc'),
  });
  assert.equal(ctx.calls.drawImage, 1);
});

test('card dimensions are exported', () => {
  assert.equal(CARD_W, 900);
  assert.ok(CARD_H > CARD_W);
});
