import { activeToken } from './session.js';
import { t, hasKey } from './i18n.js';

/** Prefers the translation of the server's error code, then the server's own text. */
export function errorMessage(data, status) {
  if (data?.code && hasKey(`err.${data.code}`)) return t(`err.${data.code}`);
  return data?.error || t('common.error', { status });
}

async function request(method, url, body, { raw = false, contentType } = {}) {
  const token = activeToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': contentType } : (body ? { 'Content-Type': 'application/json' } : {})),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    const err = new Error(errorMessage(data, res.status));
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body),
  del: url => request('DELETE', url),
  /** POSTs a file or other raw body as is. */
  upload: (url, body, contentType) => request('POST', url, body, { raw: true, contentType }),
};
