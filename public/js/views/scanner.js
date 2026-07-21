import { api } from '../api.js';
import { el } from '../app.js';

const RESULT_SHOW_MS = 2200;   // how long a result overlay stays before rescanning
const SAME_CODE_COOLDOWN_MS = 6000; // ignore re-reads of the same code in this window

/** Mobile scanning view: camera + jsQR + post-scan feedback states. */
export async function renderScanner(content) {
  const video = el('video', { playsinline: '', muted: '', autoplay: '' });
  const overlay = el('div', {});
  const view = el('div', { class: 'scanner-view' },
    video,
    el('div', { class: 'scan-frame' }, el('div', { class: 'reticle' })),
    el('div', { class: 'scan-hint' }, 'QR-Code in den Rahmen halten'),
    overlay);
  content.replaceChildren(view);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let running = true;
  let paused = false;              // true while a result overlay is visible
  let lastSeen = new Map();        // code -> timestamp, client-side debounce
  let rafId = 0;
  let lastDecode = 0;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch {
    view.replaceChildren(el('div', { class: 'camera-error' },
      el('div', {},
        el('p', {}, '📷 Kein Kamera-Zugriff.'),
        el('p', { class: 'muted' },
          'Bitte Kamera-Berechtigung erteilen. Hinweis: Der Zugriff funktioniert nur über HTTPS oder localhost.'))));
    return () => {};
  }

  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (paused || video.readyState < 2) return;
    if (ts - lastDecode < 120) return; // decode ~8×/s, keeps CPU sane
    lastDecode = ts;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qr = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (qr && qr.data) handleCode(qr.data.trim());
  }

  async function handleCode(code) {
    const now = Date.now();
    // debounce: same physical code kept in front of the camera
    if (now - (lastSeen.get(code) || 0) < SAME_CODE_COOLDOWN_MS) return;
    lastSeen.set(code, now);
    paused = true;

    let result;
    try {
      result = await api.post('/api/scan', { code });
    } catch (err) {
      result = { status: 'ERROR', message: err.message };
    }
    if (!running) return;
    showResult(result);
    if (navigator.vibrate) {
      navigator.vibrate(result.status === 'OK' ? 80 : [80, 60, 80]);
    }
  }

  let resultTimer = 0;
  function showResult(r) {
    clearTimeout(resultTimer);
    let box;
    if (r.status === 'OK') {
      box = el('div', { class: 'scan-result ok' },
        el('div', { class: 'big' }, 'OK'),
        el('div', { class: 'num' }, String(r.scan_number)),
        el('div', { class: 'detail' }, r.section || ''),
        el('div', { class: 'tap' }, 'Tippen zum Fortfahren'));
    } else if (r.status === 'DOUBLE') {
      box = el('div', { class: 'scan-result double' },
        el('div', { class: 'big' }, 'Doppelt!'),
        el('div', { class: 'detail' }, 'Dieser Code wurde bereits gescannt:'),
        el('div', { class: 'uuid' }, r.uuid),
        r.first_scanned_at
          ? el('div', { class: 'detail' },
              `Erster Scan: ${new Date(r.first_scanned_at).toLocaleTimeString('de-DE')} Uhr`)
          : null,
        el('div', { class: 'tap' }, 'Tippen zum Fortfahren'));
    } else {
      box = el('div', { class: 'scan-result error' },
        el('div', { class: 'big' }, 'Error'),
        el('div', { class: 'detail' }, r.message || 'Code ungültig'),
        el('div', { class: 'tap' }, 'Tippen zum Fortfahren'));
    }
    box.addEventListener('click', dismiss);
    overlay.replaceChildren(box);
    resultTimer = setTimeout(dismiss, RESULT_SHOW_MS);
  }

  function dismiss() {
    clearTimeout(resultTimer);
    overlay.replaceChildren();
    paused = false;
  }

  rafId = requestAnimationFrame(loop);

  return () => {
    running = false;
    cancelAnimationFrame(rafId);
    clearTimeout(resultTimer);
    stream?.getTracks().forEach(t => t.stop());
  };
}
