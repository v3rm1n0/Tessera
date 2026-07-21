import { api } from '../api.js';
import { el } from '../app.js';

/** Detail view of a section: list of double-scanned codes with their UUIDs. */
export async function renderSectionDetail(content, sectionId) {
  let data;
  try {
    data = await api.get(`/api/sections/${sectionId}/doubles`);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  content.replaceChildren(
    el('button', { class: 'btn secondary sm', onclick: () => history.back() }, '← Zurück'),
    el('div', { class: 'section-head' },
      el('h2', {}, `${data.section.name} – doppelt gescannte Codes`)),
    data.doubles.length === 0
      ? el('div', { class: 'empty' }, 'Keine doppelten Scans seit dem letzten Reset. 🎉')
      : el('div', { class: 'list' },
          data.doubles.map(d =>
            el('div', { class: 'row' },
              el('div', { class: 'grow' },
                el('div', { class: 'sub', style: 'font-size:14px' }, d.uuid),
                el('div', { class: 'muted', style: 'font-size:12.5px' },
                  d.subsection ? `${d.subsection} · ` : '',
                  `zuletzt ${new Date(d.last_attempt_at).toLocaleTimeString('de-DE')} Uhr`)),
              el('span', { class: 'badge warn' }, `${d.attempts}×`)))));
}
