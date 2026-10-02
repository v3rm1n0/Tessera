/** Whether this video track can switch the torch (Chromium on Android; not iOS Safari or desktops). */
export function torchSupported(track) {
  try {
    return Boolean(track?.getCapabilities?.().torch);
  } catch {
    return false;
  }
}

/** Switches the torch; resolves to whether it worked (a device can refuse even when it advertises it). */
export async function setTorch(track, on) {
  if (!track?.applyConstraints) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the screen on while scanning. The browser drops the lock whenever the page is hidden, so it
 * is requested again once the page is visible. Without the Wake Lock API, or when the browser refuses
 * (battery saver), everything is a no-op: scanning works, the screen may just dim.
 */
export function createWakeLock(nav, doc) {
  let wanted = false;
  let sentinel = null;

  async function request() {
    let lock;
    try {
      lock = await nav.wakeLock.request('screen');
    } catch {
      return;
    }
    if (!wanted) {
      // released while the request was in flight: give it straight back
      try { await lock.release(); } catch { /* already gone */ }
      return;
    }
    sentinel = lock;
  }

  const onVisibility = () => {
    if (wanted && doc.visibilityState === 'visible' && sentinel?.released !== false) request();
  };

  return {
    async acquire() {
      if (wanted || !nav?.wakeLock?.request) return;
      wanted = true;
      doc.addEventListener('visibilitychange', onVisibility);
      await request();
    },
    async release() {
      if (!wanted) return;
      wanted = false;
      doc.removeEventListener('visibilitychange', onVisibility);
      const held = sentinel;
      sentinel = null;
      try { await held?.release(); } catch { /* already released by the browser */ }
    },
  };
}

/**
 * Calls `onLost` once when the camera stream is gone: a track ended (another app took the camera, the
 * device was unplugged), or the page returns to the foreground with an ended track (the browser stops the
 * camera of a hidden page without telling anyone). Returns the function that stops watching.
 */
export function watchCamera(stream, doc, onLost) {
  const tracks = stream.getTracks();
  let active = true;

  function stop() {
    active = false;
    for (const track of tracks) track.removeEventListener('ended', lost);
    doc.removeEventListener('visibilitychange', onVisibility);
  }
  function lost() {
    if (!active) return;
    stop();
    onLost();
  }
  function onVisibility() {
    if (doc.visibilityState === 'visible' && tracks.some(track => track.readyState === 'ended')) lost();
  }

  for (const track of tracks) track.addEventListener('ended', lost);
  doc.addEventListener('visibilitychange', onVisibility);
  return stop;
}
