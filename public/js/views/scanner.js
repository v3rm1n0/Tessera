import { api } from '../api.js';
import { el, currentEvent } from '../app.js';
import { t, dateLocale, hasKey } from '../i18n.js';
import { icon } from '../icons.js';
import { describeResult, undoActive, UNDO_WINDOW_MS } from '../scan-result.js';
import { torchSupported, setTorch, createWakeLock, watchCamera } from '../camera.js';
import { loadVendor } from '../vendor.js';

const RESULT_SHOW_MS = 2200;   // how long a result overlay stays before rescanning
const SAME_CODE_COOLDOWN_MS = 6000; // ignore re-reads of the same code in this window

/** Mobile scanning view: camera + jsQR + post-scan feedback states. */
export async function renderScanner(content) {
  const video = el('video', { playsinline: '', autoplay: '' });
  video.muted = true; // the property, not the attribute: only a muted video may start without a tap (page reload, app launch)
  const overlay = el('div', {});
  const torchButton = el('button', {
    type: 'button', class: 'torch-btn', 'aria-label': t('scan.torch'), 'aria-pressed': 'false', hidden: '',
  }, icon('torch'));
  const manualButton = el('button', { type: 'button', class: 'manual-btn', 'aria-label': t('scan.manual') }, icon('keyboard'));
  const manualInput = el('input', {
    type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    maxlength: '40', placeholder: '550E-8400-E29B',
  });
  const manualPanel = el('form', { class: 'manual-panel', hidden: '' },
    el('label', { class: 'field' }, el('span', {}, t('scan.manualLabel')), manualInput),
    el('p', { class: 'muted manual-hint' }, t('scan.manualHint')),
    el('div', { class: 'manual-actions' },
      el('button', { type: 'button', class: 'btn secondary', onclick: () => closeManual() }, t('common.cancel')),
      el('button', { type: 'submit', class: 'btn' }, t('scan.manualSubmit'))));
  const undoText = el('span', { class: 'undo-text' });
  const undoButton = el('button', { type: 'button', class: 'btn sm', onclick: () => undoLast() }, t('scan.undo'));
  const undoBar = el('div', { class: 'undo-bar', role: 'status', hidden: '' }, undoText, undoButton);
  const cameraErrorTitle = el('p', {}, t('scan.noCamera'));
  const cameraErrorHelp = el('p', { class: 'muted' }, t('scan.cameraHelp'));
  const cameraError = el('div', { class: 'camera-error', hidden: '' },
    el('div', {},
      cameraErrorTitle,
      cameraErrorHelp,
      el('button', { type: 'button', class: 'btn', onclick: () => startCamera() }, t('scan.retry'))));
  const view = el('div', { class: 'scanner-view' },
    video,
    el('div', { class: 'scan-frame' }, el('div', { class: 'reticle' })),
    el('div', { class: 'scan-hint' }, t('scan.hint')),
    torchButton,
    manualButton,
    manualPanel,
    undoBar,
    overlay,
    cameraError);
  content.replaceChildren(view);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let stopWatching = () => {};
  let starting = null;             // a camera start in progress (retries and lost-camera events must not stack)
  let torchOn = false;
  const wakeLock = createWakeLock(navigator, document);
  let running = true;
  let paused = false;              // true while a result overlay is visible
  let manualOpen = false;          // the camera does not read codes while somebody types one
  let lastSeen = new Map();        // code -> timestamp, client-side debounce
  let rafId = 0;
  let lastDecode = 0;

  function releaseCamera() {
    stopWatching();
    stopWatching = () => {};
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }

  function syncTorch() {
    torchButton.hidden = !torchSupported(stream?.getVideoTracks()[0]);
    torchButton.classList.toggle('on', torchOn);
    torchButton.setAttribute('aria-pressed', String(torchOn));
  }

  torchButton.addEventListener('click', async () => {
    const track = stream?.getVideoTracks()[0];
    if (track && await setTorch(track, !torchOn)) {
      torchOn = !torchOn;
      syncTorch();
    }
  });

  /**
   * (Re)starts the camera. A failure shows the error panel with a retry button; a camera that is lost
   * later (another app took it, the page was in the background) restarts through here as well.
   */
  function startCamera() {
    starting ??= (async () => {
      releaseCamera();
      cameraError.hidden = true;
      let decoderMissing = false;
      try {
        try {
          await loadVendor('jsqr');
        } catch (err) {
          decoderMissing = true;
          throw err;
        }
        const next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        if (!running) { next.getTracks().forEach(track => track.stop()); return; }
        stream = next;
        video.srcObject = stream;
        await video.play();
        torchOn = false; // a new stream starts with the torch off
        syncTorch();
        stopWatching = watchCamera(stream, document, startCamera);
        wakeLock.acquire();
      } catch {
        releaseCamera();
        syncTorch();
        // a script that could not be fetched is a connection problem, not a camera problem
        cameraErrorTitle.textContent = decoderMissing ? t('err.NETWORK') : t('scan.noCamera');
        cameraErrorHelp.hidden = decoderMissing;
        cameraError.hidden = false;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function openManual() {
    manualOpen = true;
    manualPanel.hidden = false;
    manualInput.value = '';
    manualInput.focus();
  }

  function closeManual() {
    manualOpen = false;
    manualPanel.hidden = true;
    manualInput.blur();
  }

  manualButton.addEventListener('click', () => (manualOpen ? closeManual() : openManual()));
  manualPanel.addEventListener('submit', event => {
    event.preventDefault();
    const code = manualInput.value.trim();
    if (!code) return;
    closeManual();
    submitCode(code);
  });

  let lastScan = null;   // { scanId, key, at, summary } of the latest recorded scan, which the undo bar can take back
  let undoTimer = 0;
  let undoBusy = false;

  /** Shows the offer to undo the last scan while it is open, hides the bar when it closes. */
  function renderUndoBar() {
    clearTimeout(undoTimer);
    if (!undoActive(lastScan, Date.now())) {
      lastScan = null;
      undoBar.hidden = true;
      return;
    }
    undoText.textContent = t('scan.lastScan', { what: lastScan.summary });
    undoButton.hidden = false;
    undoButton.disabled = false;
    undoBar.classList.remove('note');
    undoBar.hidden = false;
    undoTimer = setTimeout(renderUndoBar, UNDO_WINDOW_MS - (Date.now() - lastScan.at));
  }

  /** A short message in place of the offer; afterwards the offer returns if it is still open. */
  function noteInUndoBar(text) {
    clearTimeout(undoTimer);
    undoText.textContent = text;
    undoButton.hidden = true;
    undoBar.classList.add('note');
    undoBar.hidden = false;
    undoTimer = setTimeout(renderUndoBar, 3000);
  }

  async function undoLast() {
    const last = lastScan;
    if (!last || undoBusy) return;
    if (!undoActive(last, Date.now())) return renderUndoBar();
    undoBusy = true;
    undoButton.disabled = true;
    try {
      await api.post(`/api/scans/${last.scanId}/void`);
      lastSeen.delete(last.key); // the same code may be scanned again right away
      lastScan = null;
      noteInUndoBar(t('scan.undone'));
    } catch (err) {
      if (err.code !== 'NETWORK') lastScan = null; // refused for good: the offer ends with the message
      noteInUndoBar(err.message);
    } finally {
      undoBusy = false;
    }
  }

  /** Only a recorded scan can be taken back; any other result (or a new scan) ends the previous offer. */
  function rememberScan(described, key, sentAt) {
    lastScan = described.scanId
      ? { scanId: described.scanId, key, summary: described.summary, at: lastScan?.scanId === described.scanId ? lastScan.at : sentAt }
      : null;
    renderUndoBar();
  }

  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (paused || manualOpen || video.readyState < 2) return;
    if (ts - lastDecode < 120) return; // decode ~8×/s, keeps CPU sane
    lastDecode = ts;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qr = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (qr && qr.data) handleCode(qr.data.trim());
  }

  function handleCode(code) {
    const now = Date.now();
    // debounce: same physical code kept in front of the camera
    if (now - (lastSeen.get(code) || 0) < SAME_CODE_COOLDOWN_MS) return;
    lastSeen.set(code, now);
    return submitCode(code);
  }

  /** Sends a scanned or typed code (a whole uuid or the short code of a card) and shows the result. */
  async function submitCode(code) {
    paused = true;
    const sentAt = Date.now(); // the undo window counts from here, never later than the server's

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
    rememberScan(showResult(result), code, sentAt);
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
    return d;
  }

  function dismiss() {
    clearTimeout(resultTimer);
    overlay.replaceChildren();
    paused = false;
  }

  // the browser knows when the device has no network at all: say so before a scan fails
  const banner = el('div', { class: 'offline-banner', role: 'status' }, t('scan.offlineBanner'));
  const syncBanner = () => { banner.hidden = navigator.onLine !== false; };
  syncBanner();
  view.append(banner);
  window.addEventListener('online', syncBanner);
  window.addEventListener('offline', syncBanner);

  rafId = requestAnimationFrame(loop);
  await startCamera();

  return () => {
    running = false;
    cancelAnimationFrame(rafId);
    clearTimeout(resultTimer);
    clearTimeout(undoTimer);
    window.removeEventListener('online', syncBanner);
    window.removeEventListener('offline', syncBanner);
    releaseCamera();
    wakeLock.release();
  };
}
