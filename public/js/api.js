import { activeToken } from './session.js';
import { t } from './i18n.js';

async function request(method, url, body) {
  const token = activeToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    const err = new Error(data?.error || t('common.error', { status: res.status }));
    err.status = res.status;
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
};
