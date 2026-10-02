import { api } from '../api.js';
import { el, currentEvent } from '../app.js';
import { t, dateLocale } from '../i18n.js';
import { buildQuery, ticketBadge } from '../codes-query.js';

const PAGE = 50;
const SEARCH_DELAY_MS = 250;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function flash(err) {
  alert(err.message || String(err));
}

/** The code as printed on the card: the first 12 hex digits of the uuid. */
const shortCode = uuid => uuid.slice(0, 13).toUpperCase();

/** Codes of the current event: search, edit holders, revoke, see the scan history, import names. */
export async function renderCodes(content) {
  const event = currentEvent();
  if (!event) {
    content.replaceChildren(el('div', { class: 'empty' }, t('dash.noEvent')));
    return;
  }
  let sections;
  try {
    sections = (await api.get(`/api/events/${event.id}/dashboard`)).sections;
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  const state = { q: '', section: '', status: 'all', items: [], total: 0, open: new Set() };
  let seq = 0;   // numbers the requests so a slow answer to an old search is ignored
  let timer = 0;

  const search = el('input', {
    type: 'text', class: 'toolbar-grow', placeholder: t('codes.search'), 'aria-label': t('codes.search'),
    autocomplete: 'off', spellcheck: 'false',
  });
  const sectionSelect = el('select', { 'aria-label': t('codes.allSections') },
    el('option', { value: '' }, t('codes.allSections')),
    sections.map(s => el('option', { value: s.id }, s.name)));
  const statusSelect = el('select', { 'aria-label': t('codes.status.all') },
    ['all', 'active', 'revoked'].map(value => el('option', { value }, t(`codes.status.${value}`))));
  const fileInput = el('input', {
    type: 'file', accept: `.xlsx,.csv,.txt,text/csv,${XLSX}`, style: 'display:none',
  });
  const importBtn = el('button', { class: 'btn secondary', type: 'button' }, t('codes.import'));
  const note = el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:6px' });
  const info = el('div', { class: 'muted', style: 'font-size:12.5px;margin:0 0 8px' });
  const list = el('div', { class: 'list' });
  const more = el('button', {
    class: 'btn secondary sm', type: 'button', style: 'margin-top:10px;display:none',
  }, t('admin.loadMore'));

  function query(offset) {
    return buildQuery({
      q: state.q.trim(), section: state.section,
      status: state.status === 'all' ? '' : state.status, limit: PAGE, offset,
    });
  }

  async function load(reset) {
    const mine = ++seq;
    try {
      const data = await api.get(`/api/events/${event.id}/tickets${query(reset ? 0 : state.items.length)}`);
      if (mine !== seq) return;
      state.items = reset ? data.items : [...state.items, ...data.items];
      state.total = data.total;
      render();
    } catch (err) {
      if (mine === seq) info.replaceChildren(el('span', { class: 'error-text' }, err.message));
    }
  }

  /** Re-reads one code (after a change that may alter its badge) and redraws. */
  async function reloadItem(item) {
    const data = await api.get(`/api/events/${event.id}/tickets${buildQuery({ q: item.uuid, limit: 1 })}`);
    const fresh = data.items.find(i => i.uuid === item.uuid);
    if (fresh) Object.assign(item, fresh);
    render();
  }

  function render() {
    info.textContent = t('codes.total', { n: state.total });
    list.replaceChildren(...(state.items.length > 0
      ? state.items.map(codeItem)
      : [el('div', { class: 'empty' }, t('codes.none'))]));
    more.style.display = state.items.length < state.total ? '' : 'none';
  }

  function codeItem(item) {
    const badge = ticketBadge(item);
    const isOpen = state.open.has(item.uuid);

    const holder = el('input', {
      type: 'text', class: 'holder-input', maxlength: '100', value: item.holder,
      placeholder: t('codes.holderPh'), 'aria-label': t('codes.holderPh'),
    });
    holder.addEventListener('change', async () => {
      try {
        const updated = await api.patch(`/api/tickets/${item.uuid}`, { holder: holder.value });
        item.holder = updated.holder;
        holder.value = updated.holder;
      } catch (err) {
        holder.value = item.holder;
        flash(err);
      }
    });

    const toggle = (open) => { if (open) state.open.delete(item.uuid); else state.open.add(item.uuid); render(); };
    const revoked = Boolean(item.revoked_at);
    const flip = async () => {
      if (!revoked && !confirm(t('codes.confirmRevoke', { code: shortCode(item.uuid) }))) return;
      try {
        const updated = await api.patch(`/api/tickets/${item.uuid}`, { revoked: !revoked });
        item.revoked_at = updated.revoked_at;
        render();
      } catch (err) { flash(err); }
    };

    const detail = isOpen ? el('div', { class: 'code-detail' }) : null;
    if (detail) showDetail(item, detail);

    return el('div', { class: 'code-item' },
      el('div', { class: 'code-row' },
        el('span', { class: 'color-dot', style: `background:${item.color}` }),
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, item.subsection ? `${item.section} – ${item.subsection}` : item.section),
          el('div', { class: 'code-meta' },
            el('span', { class: 'code-short' }, shortCode(item.uuid)),
            badge === 'revoked' ? el('span', { class: 'badge danger' }, t('codes.badge.revoked')) : null,
            badge === 'scanned' ? el('span', { class: 'badge' }, t('codes.badge.scanned')) : null)),
        holder,
        el('div', { class: 'code-actions' },
          el('button', { class: 'btn secondary sm', type: 'button', onclick: () => toggle(isOpen) },
            isOpen ? t('codes.hideDetails') : t('codes.details')),
          el('button', { class: `btn sm ${revoked ? 'secondary' : 'danger'}`, type: 'button', onclick: flip },
            revoked ? t('codes.restore') : t('codes.revoke')))),
      detail);
  }

  async function showDetail(item, container) {
    container.replaceChildren(el('div', { class: 'muted' }, '…'));
    try {
      const data = await api.get(`/api/tickets/${item.uuid}`);
      container.replaceChildren(
        el('div', { class: 'code-full' }, data.ticket.uuid),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${t('codes.created')}: ${new Date(data.ticket.created_at).toLocaleString(dateLocale())}`),
        el('div', { class: 'section-head', style: 'margin:12px 0 6px' }, el('h2', {}, t('codes.history'))),
        data.scans.length === 0
          ? el('div', { class: 'muted' }, t('codes.noScans'))
          : el('div', { class: 'scan-lines' }, data.scans.map(scan => scanLine(item, scan))));
    } catch (err) {
      container.replaceChildren(el('div', { class: 'error-text' }, err.message));
    }
  }

  function scanLine(item, scan) {
    const voided = Boolean(scan.voided_at);
    const label = `${t(`codes.result.${scan.result}`)}${scan.scan_number ? ` #${scan.scan_number}` : ''}`;
    return el('div', { class: `scan-line${voided ? ' voided' : ''}` },
      el('span', {}, new Date(scan.at).toLocaleString(dateLocale())),
      el('span', {}, label),
      el('span', { class: 'muted' }, scan.scanner || '—'),
      voided
        ? el('span', { class: 'muted' }, t('codes.voided'))
        : el('button', {
            class: 'btn secondary sm', type: 'button',
            onclick: async () => {
              if (!confirm(t('codes.confirmVoid'))) return;
              try { await api.post(`/api/scans/${scan.id}/void`); await reloadItem(item); } catch (err) { flash(err); }
            },
          }, t('codes.void')));
  }

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = search.value; load(true); }, SEARCH_DELAY_MS);
  });
  sectionSelect.addEventListener('change', () => { state.section = sectionSelect.value; load(true); });
  statusSelect.addEventListener('change', () => { state.status = statusSelect.value; load(true); });
  more.addEventListener('click', () => load(false));

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const type = /\.xlsx$/i.test(file.name) ? XLSX : 'text/csv';
    try {
      const result = await api.upload(`/api/events/${event.id}/holders`, await file.arrayBuffer(), type);
      note.className = 'muted';
      note.textContent = t('codes.importResult', result);
      await load(true);
    } catch (err) {
      note.className = 'error-text';
      note.textContent = err.message;
    }
  });

  content.replaceChildren(
    el('div', { class: 'toolbar' }, search, sectionSelect, statusSelect, importBtn, fileInput),
    note, info, list, more);
  await load(true);
  return () => { clearTimeout(timer); seq++; };
}
