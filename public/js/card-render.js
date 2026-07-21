/**
 * Admission-card ("Einlasskarte") rendering onto a <canvas>.
 * Shared by the live editor preview and the bulk PNG export so both
 * produce identical output. The section color is the card's main color.
 */

export const CARD_W = 900;
export const CARD_H = 1930;
const BACKDROP_H = Math.round(CARD_H * 0.52); // top image region

/** Readable ink color (near-black or white) for a given background hex. */
export function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? '#141414' : '#ffffff';
}

/** QR module matrix (boolean rows) for a payload, auto-sized, ECC level M. */
export function qrMatrix(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/**
 * Draws wrapped body text. Lines above `narrowFromY` use the full width;
 * lines level with the QR use the narrow left column so text flows around it.
 */
function layoutBody(ctx, text, x, yStart, lh, { fullW, narrowW, narrowFromY, maxY }) {
  let y = yStart;
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') { y += lh * 0.55; continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const width = y + lh > narrowFromY ? narrowW : fullW;
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > width) {
        ctx.fillText(line, x, y);
        y += lh;
        line = word;
        if (y > maxY) return;
      } else {
        line = test;
      }
    }
    if (line) { ctx.fillText(line, x, y); y += lh; }
    if (y > maxY) return;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawQr(ctx, matrix, x, y, size) {
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, size, size, 18);
  ctx.fill();
  const pad = Math.round(size * 0.09);
  const inner = size - pad * 2;
  const n = matrix.length;
  const cell = inner / n;
  ctx.fillStyle = '#0a0a0a';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        // slight overdraw avoids hairline seams between modules
        ctx.fillRect(x + pad + c * cell, y + pad + r * cell, cell + 0.6, cell + 0.6);
      }
    }
  }
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/**
 * Render one card. opts:
 *   { color, title, text, label, backdropImg (Image|null), matrix }
 * The canvas must be CARD_W×CARD_H.
 */
export function drawCard(ctx, { color, title, text, label, backdropImg, matrix }) {
  const ink = contrastColor(color);

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  if (backdropImg) {
    drawCover(ctx, backdropImg, 0, 0, CARD_W, BACKDROP_H);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, BACKDROP_H);
    grad.addColorStop(0, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0.04)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CARD_W, BACKDROP_H);
  }

  // title, overlaid near the bottom of the backdrop
  const pad = 44;
  if (title) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let fs = 76;
    ctx.font = `800 ${fs}px system-ui, "Segoe UI", sans-serif`;
    while (ctx.measureText(title).width > CARD_W - pad * 2 && fs > 28) {
      fs -= 2;
      ctx.font = `800 ${fs}px system-ui, "Segoe UI", sans-serif`;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(0, BACKDROP_H - fs - 46, CARD_W, fs + 46);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 12;
    ctx.fillText(title, pad, BACKDROP_H - 32);
    ctx.shadowBlur = 0;
  }

  // lower region: body text flowing around a bottom-right QR
  const lowerY = BACKDROP_H;
  const qrSize = 300;
  const qrX = CARD_W - pad - qrSize;
  const labelGap = 26;
  const qrY = CARD_H - pad - 42 - qrSize; // reserve a line below the QR for the label

  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const bodyFs = 30;
  const lh = bodyFs * 1.36;
  ctx.font = `400 ${bodyFs}px system-ui, "Segoe UI", sans-serif`;
  layoutBody(ctx, text || '', pad, lowerY + 44, lh, {
    fullW: CARD_W - pad * 2,
    narrowW: qrX - pad - 30,
    narrowFromY: qrY - 8,
    maxY: CARD_H - pad,
  });

  if (matrix) drawQr(ctx, matrix, qrX, qrY, qrSize);

  // section (– subsection) label under the QR
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let lfs = 30;
  ctx.font = `700 ${lfs}px system-ui, "Segoe UI", sans-serif`;
  while (ctx.measureText(label).width > qrSize + 44 && lfs > 15) {
    lfs -= 1;
    ctx.font = `700 ${lfs}px system-ui, "Segoe UI", sans-serif`;
  }
  ctx.fillText(label, qrX + qrSize / 2, qrY + qrSize + labelGap);
}
