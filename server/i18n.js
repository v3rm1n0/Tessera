// Texts that end up inside generated files (Excel exports). The web UI has its own dictionary in
// public/js/i18n.js; exports take a ?lang=de|en query parameter because the server does not know
// the language of the person downloading.

const HEADERS = {
  en: {
    scans: ['Time', 'Section', 'Subsection', 'UUID', 'Name', 'Result', 'Scan no.', 'Scanner', 'Voided'],
    tickets: ['Section', 'Subsection', 'UUID', 'Created', 'Name (recipient)'],
    cardList: ['Section', 'UUID', 'Name (recipient)'],
  },
  de: {
    scans: ['Zeit', 'Abteilung', 'Unterabteilung', 'UUID', 'Name', 'Ergebnis', 'Scan-Nr.', 'Scanner', 'Rückgängig'],
    tickets: ['Abteilung', 'Unterabteilung', 'UUID', 'Erstellt', 'Name (Empfänger)'],
    cardList: ['Abteilung', 'UUID', 'Name (Empfänger)'],
  },
};

// the sheet of an event that has no sections yet
const EMPTY_SHEET = { en: 'Empty', de: 'Leer' };

const RESULTS = {
  en: { OK: 'OK', DOUBLE: 'Duplicate' },
  de: { OK: 'OK', DOUBLE: 'Doppelt' },
};

/** 'de' or 'en'; anything else falls back to English. */
export function normalizeLang(value) {
  return value === 'de' ? 'de' : 'en';
}

export function emptySheetName(lang) {
  return EMPTY_SHEET[normalizeLang(lang)];
}

export function excelHeaders(lang, sheet) {
  return HEADERS[normalizeLang(lang)][sheet];
}

export function resultLabel(lang, result) {
  return RESULTS[normalizeLang(lang)][result] ?? result;
}
