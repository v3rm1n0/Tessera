const KEY = 'voreinlass_lang';

export const dict = {
  de: {
    brand: 'Voreinlass',
    'nav.dashboard': 'Dashboard',
    'nav.scan': 'Scannen',
    'nav.admin': 'Verwaltung',
    'title.dashboard': 'Dashboard',
    'title.section': 'Abteilung',
    'title.scan': 'Scannen',
    'title.admin': 'Verwaltung',
    'title.card': 'Einlasskarte',
    'role.OWNER': 'Owner',
    'role.EVENT_ADMIN': 'Event-Admin',
    'role.SCANNER': 'Scanner',
    'account.add': 'Konto hinzufügen',
    'account.logout': 'Abmelden ({name})',
    'menu.label': 'Menü',
    'settings.theme': 'Design',
    'settings.system': 'System',
    'settings.light': 'Hell',
    'settings.dark': 'Dunkel',
    'settings.language': 'Sprache',
    'common.cancel': 'Abbrechen',
    'common.back': '← Zurück',
    'login.username': 'Benutzername',
    'login.password': 'Passwort',
    'login.submit': 'Anmelden',
    'dash.noEvent': 'Kein Event zugewiesen. Bitte beim Owner melden.',
    'dash.sections': 'Abteilungen',
    'dash.scansToday': 'Heute · Total Scans',
    'dash.noSections': 'Noch keine Abteilungen angelegt.',
    'dash.codes': '{n} Codes',
    'dash.doubleTitle': 'Doppelt gescannt',
    'dash.scansTodayTitle': 'Scans heute',
    'dash.resetFooter': 'Zähler-Reset täglich um {time} Uhr · Stand: {now}',
    'section.doublesHead': '{name} – doppelt gescannte Codes',
    'section.noDoubles': 'Keine doppelten Scans seit dem letzten Reset. 🎉',
    'section.lastAt': 'zuletzt {time} Uhr',
    'section.attempts': '{n}×',
  },
  en: {
    brand: 'Voreinlass',
    'nav.dashboard': 'Dashboard',
    'nav.scan': 'Scan',
    'nav.admin': 'Administration',
    'title.dashboard': 'Dashboard',
    'title.section': 'Section',
    'title.scan': 'Scan',
    'title.admin': 'Administration',
    'title.card': 'Admission card',
    'role.OWNER': 'Owner',
    'role.EVENT_ADMIN': 'Event Admin',
    'role.SCANNER': 'Scanner',
    'account.add': 'Add account',
    'account.logout': 'Log out ({name})',
    'menu.label': 'Menu',
    'settings.theme': 'Theme',
    'settings.system': 'System',
    'settings.light': 'Light',
    'settings.dark': 'Dark',
    'settings.language': 'Language',
    'common.cancel': 'Cancel',
    'common.back': '← Back',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'dash.noEvent': 'No event assigned. Please contact the owner.',
    'dash.sections': 'Sections',
    'dash.scansToday': 'Today · total scans',
    'dash.noSections': 'No sections created yet.',
    'dash.codes': '{n} codes',
    'dash.doubleTitle': 'Scanned twice',
    'dash.scansTodayTitle': 'Scans today',
    'dash.resetFooter': 'Counter reset daily at {time} · as of {now}',
    'section.doublesHead': '{name} – codes scanned twice',
    'section.noDoubles': 'No duplicate scans since the last reset. 🎉',
    'section.lastAt': 'last {time}',
    'section.attempts': '{n}×',
  },
};

function interpolate(str, params) {
  return params ? str.replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`)) : str;
}

export function translate(lang, key, params) {
  const table = dict[lang] || dict.de;
  const str = table[key];
  if (str === undefined) return key;
  return interpolate(str, params);
}

function detectLang() {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(KEY);
    if (saved === 'de' || saved === 'en') return saved;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'de';
  }
  return 'de';
}

let current = null;

export function getLang() {
  if (!current) current = detectLang();
  return current;
}

export function t(key, params) {
  return translate(getLang(), key, params);
}

export function dateLocale() {
  return getLang() === 'en' ? 'en-GB' : 'de-DE';
}

export function setLang(lang) {
  if (lang !== 'de' && lang !== 'en') return;
  current = lang;
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, lang);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    window.dispatchEvent(new Event('voreinlass:relang'));
  }
}

export function initI18n() {
  if (typeof document !== 'undefined') document.documentElement.lang = getLang();
}
