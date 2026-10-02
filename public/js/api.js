import { activeToken } from './session.js';
import { t, hasKey } from './i18n.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Prefers the translation of the server's error code, then the server's own text. */
export function errorMessage(data, status) {
  if (data?.code && hasKey(`err.${data.code}`)) return t(`err.${data.code}`);
  return data?.error || t('common.error', { status });
}

let onUnauthorized = null;

/** Called whenever an authenticated request is answered with 401 (the session is gone). */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

function networkError() {
  const err = new Error(t('err.NETWORK'));
  err.status = 0;
  err.code = 'NETWORK';
  return err;
}

/**
 * options: timeoutMs (default 15 s; the request is aborted when it takes longer), skipAuthHandler
 * (for calls where a 401 is an expected answer, such as login), raw + contentType (send `body` as is).
 */
async function request(method, url, body, options = {}) {
  const { raw = false, contentType, timeoutMs = DEFAULT_TIMEOUT_MS, skipAuthHandler = false } = options;
  const token = activeToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(raw ? { 'Content-Type': contentType } : (body ? { 'Content-Type': 'application/json' } : {})),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: raw ? body : (body ? JSON.stringify(body) : undefined),
        signal: controller.signal,
      });
    } catch {
      throw networkError(); // offline, DNS/TLS failure, connection reset, or our own timeout
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      if (controller.signal.aborted) throw networkError(); // the body stalled half-way
    }
    if (!res.ok) {
      if (res.status === 401 && !skipAuthHandler) {
        try { onUnauthorized?.(); } catch { /* a faulty handler must not hide the real error */ }
      }
      const err = new Error(errorMessage(data, res.status));
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: (url, options) => request('GET', url, undefined, options),
  post: (url, body, options) => request('POST', url, body ?? {}, options),
  put: (url, body, options) => request('PUT', url, body ?? {}, options),
  patch: (url, body, options) => request('PATCH', url, body, options),
  del: (url, options) => request('DELETE', url, undefined, options),
  /** POSTs a file or other raw body as is. */
  upload: (url, body, contentType, options) => request('POST', url, body, { ...options, raw: true, contentType }),
};
