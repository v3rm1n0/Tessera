import { api } from '../api.js';
import { el, currentEvent } from '../app.js';
import { t, dateLocale, hasKey } from '../i18n.js';
import { describeResult } from '../scan-result.js';

const RESULT_SHOW_MS = 2200;   // how long a result overlay stays before rescanning
const SAME_CODE_COOLDOWN_MS = 6000; // ignore re-reads of the same code in this window

/** Mobile scanning view: camera + jsQR + post-scan feedback states. */
export async function renderScanner(content) {
  const video = el('video', { playsinline: '', muted: '', autoplay: '' });
  const overlay = el('div', {});
  const view = el('div', { class: 'scanner-view' },
    video,
    el('div', { class: 'scan-frame' }, el('div', { class: 'reticle' })),
    el('div', { class: 'scan-hint' }, t('scan.hint')),
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
        el('p', {}, t('scan.noCamera')),
        el('p', { class: 'muted' },
          t('scan.cameraHelp')))));
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
      if (err.code === 'NETWORK') {
        // the scan may not have reached the server: the same code must be scannable again at once
        lastSeen.delete(code);
        result = { status: 'OFFLINE' };
      } else {
        result = { status: 'ERROR', code: err.code, message: err.message };
      }
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
    const d = describeResult(r, { t, hasKey, locale: dateLocale(), timeZone: currentEvent()?.timezone || undefined });
    const box = el('div', { class: `scan-result ${d.kind}` },
      ...d.parts.map(p => el('div', { class: p.cls }, p.text)),
      el('div', { class: 'tap' }, t('scan.tap')));
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

  // the browser knows when the device has no network at all: say so before a scan fails
  const banner = el('div', { class: 'offline-banner', role: 'status' }, t('scan.offlineBanner'));
  const syncBanner = () => { banner.hidden = navigator.onLine !== false; };
  syncBanner();
  view.append(banner);
  window.addEventListener('online', syncBanner);
  window.addEventListener('offline', syncBanner);

  return () => {
    running = false;
    cancelAnimationFrame(rafId);
    clearTimeout(resultTimer);
    window.removeEventListener('online', syncBanner);
    window.removeEventListener('offline', syncBanner);
    stream?.getTracks().forEach(t => t.stop());
  };
}
