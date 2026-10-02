/** Query string from filter values; empty values are dropped, the rest is encoded. */
export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** What a code row shows next to the code: revoked beats scanned today beats nothing special. */
export function ticketBadge(item) {
  if (item.revoked_at) return 'revoked';
  return item.scanned_today ? 'scanned' : 'active';
}
