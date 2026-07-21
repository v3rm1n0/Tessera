import { api } from '../api.js';
import { el } from '../app.js';
import { t, dateLocale } from '../i18n.js';

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
    el('button', { class: 'btn secondary sm', onclick: () => history.back() }, t('common.back')),
    el('div', { class: 'section-head' },
      el('h2', {}, t('section.doublesHead', { name: data.section.name }))),
    data.doubles.length === 0
      ? el('div', { class: 'empty' }, t('section.noDoubles'))
      : el('div', { class: 'list' },
          data.doubles.map(d =>
            el('div', { class: 'row' },
              el('div', { class: 'grow' },
                el('div', { class: 'sub', style: 'font-size:14px' }, d.uuid),
                el('div', { class: 'muted', style: 'font-size:12.5px' },
                  d.subsection ? `${d.subsection} · ` : '',
                  t('section.lastAt', { time: new Date(d.last_attempt_at).toLocaleTimeString(dateLocale()) }))),
              el('span', { class: 'badge warn' }, t('section.attempts', { n: d.attempts })))));
}
