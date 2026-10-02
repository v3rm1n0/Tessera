// Excel worksheet names: at most 31 characters, none of \ / ? * [ ] :, no leading or trailing
// apostrophe, unique within a workbook regardless of case, and "History" is reserved.
const ILLEGAL = /[\\/?*[\]:]/g;
const MAX_LEN = 31;

function clean(raw) {
  return String(raw ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
}

/**
 * Turns an arbitrary label into a valid, unique sheet name. `used` holds the lower-cased names
 * taken so far (seed it with 'history') and is updated with the returned name.
 */
export function uniqueSheetName(raw, used) {
  const base = clean(clean(raw).slice(0, MAX_LEN)) || 'Sheet';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = (clean(base.slice(0, MAX_LEN - suffix.length)) || 'Sheet') + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}
