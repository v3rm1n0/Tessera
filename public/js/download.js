import { activeToken } from './session.js';
import { errorMessage } from './api.js';

// how long a download's object URL stays alive after the click: some browsers (Safari, Firefox)
// only start reading the blob a moment later, and revoking it at once cancels the save
export const REVOKE_DELAY_MS = 30_000;

/** The file name in a Content-Disposition header, or null. */
export function filenameFromDisposition(header) {
  const match = /filename="?([^";]+)"?/i.exec(header || '');
  return match ? match[1] : null;
}

/** Saves a blob under a name through a temporary link. The environment is injectable for tests. */
export function saveBlob(blob, filename, { doc = document, urls = URL, schedule = setTimeout } = {}) {
  const url = urls.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.append(link);
  link.click();
  link.remove();
  schedule(() => urls.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Fetches an authenticated file and saves it. The token travels in a header, never in the URL
 * (which would leak via logs, history and referrers).
 */
export async function downloadFile(url, fallbackName, { save = saveBlob } = {}) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${activeToken()}` } });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not a JSON error */ }
    const err = new Error(errorMessage(data, res.status));
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  save(await res.blob(), filenameFromDisposition(res.headers.get('content-disposition')) || fallbackName);
}
