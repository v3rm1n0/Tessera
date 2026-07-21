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
    'login.username': 'Benutzername',
    'login.password': 'Passwort',
    'login.submit': 'Anmelden',
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
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',
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
