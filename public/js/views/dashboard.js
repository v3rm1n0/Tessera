import { api } from '../api.js';
import { el, state, currentEvent } from '../app.js';
import { t, dateLocale } from '../i18n.js';

export async function renderDashboard(content) {
  const event = currentEvent();
  if (!event) {
    content.replaceChildren(el('div', { class: 'empty' },
      t('dash.noEvent')));
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
          el('div', { class: 'label' }, t('dash.sections')),
          el('div', { class: 'value' }, String(data.total_sections))),
        el('div', { class: 'card' },
          el('div', { class: 'label' }, t('dash.scansToday')),
          el('div', { class: 'value' }, String(data.total_scans_today)))),
      data.sections.length === 0
        ? el('div', { class: 'empty' }, t('dash.noSections'))
        : el('div', { class: 'list' },
            data.sections.map(s =>
              el('button', { class: 'row', onclick: () => { location.hash = `#/sections/${s.id}`; } },
                el('span', { class: 'color-dot', style: `background:${s.color}` }),
                el('div', { class: 'grow' },
                  el('div', { class: 'title' }, s.name),
                  el('div', { class: 'sub' }, t('dash.codes', { n: s.ticket_count }))),
                s.doubles_today > 0
                  ? el('span', { class: 'badge warn', title: t('dash.doubleTitle') }, String(s.doubles_today))
                  : null,
                el('span', {
                  class: 'badge', title: t('dash.scansTodayTitle'),
                  style: `background:${s.color}22;color:${s.color};border-color:${s.color}`,
                }, String(s.scans_today))))),
      el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:14px' },
        t('dash.resetFooter', {
          time: data.event.reset_time, zone: data.event.timezone || 'server', now: clock(data.event.timezone),
        })));
  }

  await load();
  const timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}

/** Current time of day, on the wall clock of the event's zone when the browser knows it. */
function clock(timeZone) {
  try {
    return new Date().toLocaleTimeString(dateLocale(), timeZone ? { timeZone } : undefined);
  } catch {
    return new Date().toLocaleTimeString(dateLocale());
  }
}
