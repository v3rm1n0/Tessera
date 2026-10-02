import { api } from '../api.js';
import { el, currentEvent } from '../app.js';
import { t, dateLocale, getLang } from '../i18n.js';
import { buildQuery } from '../codes-query.js';
import { downloadFile } from '../download.js';
import { formatInZone } from '../time-format.js';

const PAGE = 50;
const SEARCH_DELAY_MS = 250;

function flash(err) {
  alert(err.message || String(err));
}

/** Scan log of the current event: every scan with who and when, filterable, exportable to Excel. */
export async function renderLog(content) {
  const event = currentEvent();
  if (!event) {
    content.replaceChildren(el('div', { class: 'empty' }, t('dash.noEvent')));
    return;
  }
  let days;
  let zone;
  try {
    const history = await api.get(`/api/events/${event.id}/history`);
    days = history.days;
    zone = history.event.timezone || undefined;
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  const state = { q: '', result: '', day: '', items: [], next: null };
  let seq = 0;
  let timer = 0;
  const fmt = (ms, options) => formatInZone(ms, options, zone, dateLocale());

  const search = el('input', {
    type: 'text', class: 'toolbar-grow', placeholder: t('codes.search'), 'aria-label': t('codes.search'),
    autocomplete: 'off', spellcheck: 'false',
  });
  const resultSelect = el('select', { 'aria-label': t('log.allResults') },
    el('option', { value: '' }, t('log.allResults')),
    el('option', { value: 'OK' }, t('codes.result.OK')),
    el('option', { value: 'DOUBLE' }, t('codes.result.DOUBLE')));
  const daySelect = el('select', { 'aria-label': t('log.allDays') },
    el('option', { value: '' }, t('log.allDays')),
    days.map(day => el('option', { value: day.start },
      fmt(day.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))));
  const exportBtn = el('button', { class: 'btn secondary', type: 'button' }, t('log.export'));
  const list = el('div', { class: 'list' });
  const more = el('button', {
    class: 'btn secondary sm', type: 'button', style: 'margin-top:10px;display:none',
  }, t('admin.loadMore'));
  const info = el('div', { class: 'muted', style: 'font-size:12.5px;margin:0 0 8px' });

  const filters = () => ({ q: state.q.trim(), result: state.result, day: state.day });

  async function load(reset) {
    const mine = ++seq;
    const before = reset ? undefined : state.next;
    try {
      const data = await api.get(`/api/events/${event.id}/scans${buildQuery({ ...filters(), limit: PAGE, before })}`);
      if (mine !== seq) return;
      state.items = reset ? data.items : [...state.items, ...data.items];
      state.next = data.next_before;
      render();
    } catch (err) {
      if (mine === seq) info.replaceChildren(el('span', { class: 'error-text' }, err.message));
    }
  }

  function render() {
    info.textContent = '';
    list.replaceChildren(...(state.items.length > 0
      ? state.items.map(logRow)
      : [el('div', { class: 'empty' }, t('log.none'))]));
    more.style.display = state.next ? '' : 'none';
  }

  function logRow(item) {
    const voided = Boolean(item.voided_at);
    const label = item.subsection ? `${item.section} – ${item.subsection}` : item.section;
    const result = `${t(`codes.result.${item.result}`)}${item.scan_number ? ` #${item.scan_number}` : ''}`;
    return el('div', { class: `log-row${voided ? ' voided' : ''}` },
      el('span', {}, fmt(item.at, { dateStyle: 'short', timeStyle: 'medium' })),
      el('span', { class: item.result === 'DOUBLE' ? 'log-double' : '' }, result),
      el('div', { class: 'grow' },
        el('div', {}, label),
        el('div', { class: 'code-short' },
          `${item.uuid.slice(0, 13).toUpperCase()}${item.holder ? ` · ${item.holder}` : ''}`)),
      el('span', { class: 'muted' }, voided ? `${item.scanner || '—'} · ${t('codes.voided')}` : (item.scanner || '—')));
  }

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = search.value; load(true); }, SEARCH_DELAY_MS);
  });
  resultSelect.addEventListener('change', () => { state.result = resultSelect.value; load(true); });
  daySelect.addEventListener('change', () => { state.day = daySelect.value; load(true); });
  more.addEventListener('click', () => load(false));
  exportBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    downloadFile(
      `/api/events/${event.id}/scans.xlsx${buildQuery({ ...filters(), lang: getLang() })}`,
      `scans-event-${event.id}.xlsx`)
      .catch(flash)
      .finally(() => { exportBtn.disabled = false; });
  });

  content.replaceChildren(
    el('div', { class: 'toolbar' }, search, resultSelect, daySelect, exportBtn),
    info, list, more);
  await load(true);
  return () => { clearTimeout(timer); seq++; };
}
