const KEY = 'tessera_theme';
const PREFS = ['system', 'light', 'dark'];
const META_COLOR = { dark: '#1b1b1b', light: '#f1f1f1' };

export function resolveTheme(pref, prefersLight) {
  if (pref === 'dark' || pref === 'light') return pref;
  return prefersLight ? 'light' : 'dark';
}

export function getThemePref() {
  if (typeof localStorage === 'undefined') return 'system';
  const p = localStorage.getItem(KEY);
  return PREFS.includes(p) ? p : 'system';
}

function prefersLight() {
  return typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: light)').matches;
}

let mql = null;
let mqlHandler = null;

export function applyTheme() {
  if (typeof document === 'undefined') return;
  const pref = getThemePref();
  const effective = resolveTheme(pref, prefersLight());
  document.documentElement.dataset.theme = effective;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLOR[effective]);

  // Only track OS changes while in system mode.
  if (typeof matchMedia !== 'undefined') {
    if (!mql) mql = matchMedia('(prefers-color-scheme: light)');
    if (mqlHandler) mql.removeEventListener('change', mqlHandler);
    mqlHandler = pref === 'system' ? () => applyTheme() : null;
    if (mqlHandler) mql.addEventListener('change', mqlHandler);
  }
}

export function setThemePref(pref) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, pref);
  applyTheme();
}

export function initTheme() {
  applyTheme();
}
