import { api } from '../api.js';
import { el, currentEvent } from '../app.js';
import { t, dateLocale } from '../i18n.js';
import { barHeights } from '../bars.js';
import { formatInZone } from '../time-format.js';

const CHART_PX = 64;
const HOUR_MS = 3_600_000;
const AXIS_EVERY = 6; // label every sixth hour slot

/** Per-day history: totals, activity per section and a bar chart of OK scans per hour. */
export async function renderHistory(content) {
  const event = currentEvent();
  if (!event) {
    content.replaceChildren(el('div', { class: 'empty' }, t('dash.noEvent')));
    return;
  }
  let data;
  try {
    data = await api.get(`/api/events/${event.id}/history`);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }
  if (data.days.length === 0) {
    content.replaceChildren(el('div', { class: 'empty' }, t('history.empty')));
    return;
  }
  const zone = data.event.timezone || undefined;
  content.replaceChildren(...data.days.map(day => dayCard(day, zone)));
}

const format = (ms, options, zone) => formatInZone(ms, options, zone, dateLocale());

function dayCard(day, zone) {
  const time = { hour: '2-digit', minute: '2-digit' };
  const heights = barHeights(day.hourly, CHART_PX);
  const slots = day.hourly.map((n, i) => format(day.start + i * HOUR_MS, time, zone));

  return el('div', { class: 'card day-card' },
    el('div', { class: 'day-head' },
      el('div', {},
        el('div', { class: 'title' },
          format(day.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, zone)),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${format(day.start, time, zone)} – ${format(day.end, time, zone)}`)),
      el('div', { class: 'day-totals' },
        el('div', {}, t('history.scansTotal', { n: day.ok })),
        day.doubles > 0 ? el('span', { class: 'badge warn' }, t('history.doublesTotal', { n: day.doubles })) : null)),
    el('div', { class: 'bars' },
      day.hourly.map((n, i) => el('div', { class: 'bar-slot', title: t('history.hour', { time: slots[i], n }) },
        el('div', { class: 'bar', style: `height:${heights[i]}px` })))),
    el('div', { class: 'bar-axis' },
      day.hourly.map((_, i) => el('span', {}, i % AXIS_EVERY === 0 ? slots[i] : ''))),
    day.sections.length > 0
      ? el('div', { class: 'chips' }, day.sections.map(s =>
          el('span', { class: 'chip' },
            el('span', { class: 'color-dot', style: `background:${s.color};display:inline-block;margin-right:4px` }),
            `${s.name} `, el('strong', {}, String(s.ok)), s.doubles > 0 ? ` · ${s.doubles}×` : '')))
      : null);
}
