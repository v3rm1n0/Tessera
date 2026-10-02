// Texts that end up inside generated files (Excel exports). The web UI has its own dictionary in
// public/js/i18n.js; exports take a ?lang=de|en query parameter because the server does not know
// the language of the person downloading.

const HEADERS = {
  en: {
    scans: ['Time', 'Section', 'Subsection', 'UUID', 'Name', 'Result', 'Scan no.', 'Scanner', 'Voided'],
  },
  de: {
    scans: ['Zeit', 'Abteilung', 'Unterabteilung', 'UUID', 'Name', 'Ergebnis', 'Scan-Nr.', 'Scanner', 'Rückgängig'],
  },
};

const RESULTS = {
  en: { OK: 'OK', DOUBLE: 'Duplicate' },
  de: { OK: 'OK', DOUBLE: 'Doppelt' },
};

/** 'de' or 'en'; anything else falls back to English. */
export function normalizeLang(value) {
  return value === 'de' ? 'de' : 'en';
}

export function excelHeaders(lang, sheet) {
  return HEADERS[normalizeLang(lang)][sheet];
}

export function resultLabel(lang, result) {
  return RESULTS[normalizeLang(lang)][result] ?? result;
}
