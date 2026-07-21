import { api } from '../api.js';
import { el, state, currentEvent } from '../app.js';

export async function renderDashboard(content) {
  const event = currentEvent();
  if (!event) {
    content.replaceChildren(el('div', { class: 'empty' },
      'Kein Event zugewiesen. Bitte beim Owner melden.'));
    return;
  }

  const container = el('div', {});
  content.replaceChildren(container);

  async function load() {
    let data;
    try {
      data = await api.get(`/api/events/${event.id}/dashboard`);
    } catch (err) {
      container.replaceChildren(el('div', { class: 'error-text' }, err.message));
      return;
    }

    container.replaceChildren(
      el('div', { class: 'cards' },
        el('div', { class: 'card' },
          el('div', { class: 'label' }, 'Abteilungen'),
          el('div', { class: 'value' }, String(data.total_sections))),
        el('div', { class: 'card' },
          el('div', { class: 'label' }, 'Heute · Total Scans'),
          el('div', { class: 'value' }, String(data.total_scans_today)))),
      data.sections.length === 0
        ? el('div', { class: 'empty' }, 'Noch keine Abteilungen angelegt.')
        : el('div', { class: 'list' },
            data.sections.map(s =>
              el('button', { class: 'row', onclick: () => { location.hash = `#/sections/${s.id}`; } },
                el('div', { class: 'grow' },
                  el('div', { class: 'title' }, s.name),
                  el('div', { class: 'sub' }, `${s.ticket_count} Codes`)),
                s.doubles_today > 0
                  ? el('span', { class: 'badge warn', title: 'Doppelt gescannt' }, String(s.doubles_today))
                  : null,
                el('span', { class: 'badge', title: 'Scans heute' }, String(s.scans_today))))),
      el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:14px' },
        `Zähler-Reset täglich um ${data.event.reset_time} Uhr · Stand: ${new Date().toLocaleTimeString('de-DE')}`));
  }

  await load();
  const timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}
