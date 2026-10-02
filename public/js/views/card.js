import { api } from '../api.js';
import { activeToken } from '../session.js';
import { el } from '../app.js';
import { CARD_W, CARD_H, drawCard, qrMatrix, shortCode } from '../card-render.js';
import { loadVendor } from '../vendor.js';
import { saveBlob } from '../download.js';
import { safeName, filterTickets, scopeOptions, exportZip, exportPdf } from '../card-export.js';
import { t } from '../i18n.js';

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

/** Admission-card editor (EVENT_ADMIN): defined once per event, exported as PNGs in a ZIP per ticket. */
export async function renderCardEditor(content, eventId) {
  let cfg;
  try {
    [cfg] = await Promise.all([
      api.get(`/api/events/${eventId}/card`),
      loadVendor('qrcode').catch(() => { throw new Error(t('err.NETWORK')); }), // the preview needs it
    ]);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  const sample = cfg.sample || { color: '#4f9cf5', label: t('card.sampleLabel') };
  let backdropImg = null;

  const titleInput = el('input', {
    type: 'text', maxlength: '200',
    value: cfg.title || t('card.defaultTitle'),
  });
  const textInput = el('textarea', {
    rows: '11', maxlength: '4000',
    placeholder: t('card.textPh'),
  });
  textInput.value = cfg.text || '';

  const canvas = el('canvas', { class: 'card-preview' });
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');

  function preview() {
    drawCard(ctx, {
      color: sample.color,
      title: titleInput.value,
      text: textInput.value,
      label: sample.label,
      code: shortCode(PLACEHOLDER_UUID),
      backdropImg,
      matrix: qrMatrix(PLACEHOLDER_UUID),
    });
  }
  titleInput.addEventListener('input', preview);
  textInput.addEventListener('input', preview);

  const boldBtn = el('button', { type: 'button', class: 'btn secondary sm', title: t('card.boldTitle') }, 'F');
  boldBtn.style.fontWeight = '800';
  boldBtn.addEventListener('click', () => {
    const start = textInput.selectionStart;
    const end = textInput.selectionEnd;
    const v = textInput.value;
    const sel = v.slice(start, end) || t('card.boldPlaceholder');
    textInput.value = `${v.slice(0, start)}**${sel}**${v.slice(end)}`;
    textInput.focus();
    textInput.setSelectionRange(start + 2, start + 2 + sel.length);
    preview();
  });

  const saveBtn = el('button', { class: 'btn' }, t('card.save'));
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.put(`/api/events/${eventId}/card`, { title: titleInput.value, text: textInput.value });
      cfg.title = titleInput.value;
      cfg.text = textInput.value;
      saveBtn.textContent = t('card.saved');
      setTimeout(() => { saveBtn.textContent = t('card.save'); saveBtn.disabled = false; }, 1200);
    } catch (err) { alert(err.message); saveBtn.disabled = false; }
  });

  async function loadBackdrop() {
    if (!cfg.has_backdrop) { backdropImg = null; preview(); return; }
    // fetch with the auth header so the token never rides in the URL, then
    // hand the bytes to an <img> via an object URL
    try {
      const res = await fetch(`/api/events/${eventId}/card/backdrop`, {
        headers: { Authorization: `Bearer ${activeToken()}` },
      });
      if (!res.ok) throw new Error('backdrop fetch failed');
      const url = URL.createObjectURL(await res.blob());
      const img = new Image();
      img.onload = () => { backdropImg = img; preview(); URL.revokeObjectURL(url); };
      img.onerror = () => { backdropImg = null; preview(); URL.revokeObjectURL(url); };
      img.src = url;
    } catch {
      backdropImg = null;
      preview();
    }
  }

  const fileInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none',
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { alert(t('card.tooLarge')); fileInput.value = ''; return; }
    try {
      const res = await fetch(`/api/events/${eventId}/card/backdrop`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: `Bearer ${activeToken()}` },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('card.uploadFailed'));
      cfg.has_backdrop = true;
      removeBtn.style.display = '';
      loadBackdrop();
    } catch (err) { alert(err.message); }
    fileInput.value = '';
  });

  const uploadBtn = el('button', { class: 'btn secondary' }, t('card.chooseBackdrop'));
  uploadBtn.addEventListener('click', () => fileInput.click());
  const removeBtn = el('button', {
    class: 'btn secondary sm',
    style: cfg.has_backdrop ? '' : 'display:none',
  }, t('card.removeBackdrop'));
  removeBtn.addEventListener('click', async () => {
    try {
      await api.del(`/api/events/${eventId}/card/backdrop`);
      cfg.has_backdrop = false; backdropImg = null; removeBtn.style.display = 'none'; preview();
    } catch (err) { alert(err.message); }
  });

  const progress = el('span', { class: 'muted', style: 'font-size:13px' });

  const singleBtn = el('button', { class: 'btn secondary' }, t('card.previewPng'));
  singleBtn.addEventListener('click', () => {
    const off = document.createElement('canvas');
    off.width = CARD_W; off.height = CARD_H;
    drawCard(off.getContext('2d'), {
      color: sample.color, title: titleInput.value, text: textInput.value,
      label: sample.label, code: shortCode(PLACEHOLDER_UUID), backdropImg, matrix: qrMatrix(PLACEHOLDER_UUID),
    });
    off.toBlob(blob => saveBlob(blob, `Einlasskarte-${safeName(cfg.event)}-${t('card.previewSuffix')}.png`), 'image/png');
  });

  const xlsxCheckbox = el('input', { type: 'checkbox', id: 'incl-xlsx', style: 'width:auto;margin:0' });
  const xlsxLabel = el('label', {
    for: 'incl-xlsx',
    style: 'display:flex;align-items:center;gap:8px;margin:0;color:var(--color-text-primary);cursor:pointer;font-size:13.5px',
  }, xlsxCheckbox, t('card.inclXlsx'));

  // what to export: everything, one section (with its subsections), or one subsection
  const options = scopeOptions(cfg.groups || []);
  const optionLabel = o => {
    const name = o.direct ? `${o.section} – ${t('card.noSubsection')}` : (o.subsection ? `${o.section} – ${o.subsection}` : o.section);
    return `${name} (${o.count})`;
  };
  const scopeSelect = el('select', {},
    el('option', { value: 'all' }, t('card.scopeAll', { n: cfg.total_tickets })),
    ...options.map((o, i) => el('option', { value: String(i) }, optionLabel(o))));
  const chosen = () => (scopeSelect.value === 'all' ? null : options[Number(scopeSelect.value)]);

  // PNG files in a ZIP (for the printer's own workflow), or ready-to-print sheets
  const formatSelect = el('select', {},
    el('option', { value: 'zip' }, t('card.formatZip')),
    el('option', { value: 'pdf' }, t('card.formatPdf')));

  const bulkBtn = el('button', { class: 'btn' });
  function labelBulk() {
    const option = chosen();
    const pdf = formatSelect.value === 'pdf';
    bulkBtn.textContent = cfg.total_tickets === 0 ? t('card.noUuids')
      : option ? t(pdf ? 'card.exportScopePdf' : 'card.exportScope', { n: option.count })
        : t(pdf ? 'card.exportAllPdf' : 'card.exportAll', { n: cfg.total_tickets });
    xlsxLabel.style.display = pdf ? 'none' : 'flex'; // the code lists belong in the ZIP
  }
  labelBulk();
  bulkBtn.disabled = cfg.total_tickets === 0;
  scopeSelect.addEventListener('change', labelBulk);
  formatSelect.addEventListener('change', labelBulk);

  const cancelBtn = el('button', { class: 'btn secondary', type: 'button', hidden: '' }, t('common.cancel'));
  let controller = null;
  cancelBtn.addEventListener('click', () => controller?.abort());
  function setBusy(busy) {
    bulkBtn.disabled = busy;
    scopeSelect.disabled = busy;
    formatSelect.disabled = busy;
    xlsxCheckbox.disabled = busy;
    cancelBtn.hidden = !busy;
  }

  // one shared canvas for all cards: draw, then encode
  const off = document.createElement('canvas');
  off.width = CARD_W; off.height = CARD_H;
  const offContext = off.getContext('2d');
  const draw = tk => drawCard(offContext, {
    color: tk.color, title: titleInput.value, text: textInput.value,
    label: tk.subsection ? `${tk.section} – ${tk.subsection}` : tk.section,
    code: shortCode(tk.uuid), backdropImg, matrix: qrMatrix(tk.uuid),
  });
  const encode = (type, quality) => new Promise((resolve, reject) =>
    off.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), type, quality));
  const renderCard = tk => { draw(tk); return encode('image/png'); };
  const renderJpeg = async tk => { draw(tk); return new Uint8Array(await (await encode('image/jpeg', 0.92)).arrayBuffer()); };

  bulkBtn.addEventListener('click', async () => {
    controller = new AbortController();
    const { signal } = controller;
    setBusy(true);
    progress.textContent = t('card.loadingUuids');
    try {
      const pdf = formatSelect.value === 'pdf';
      if (!pdf) await loadVendor('jszip').catch(() => { throw new Error(t('err.NETWORK')); });
      const option = chosen();
      const [all, sheets] = await Promise.all([
        api.get(`/api/events/${eventId}/card/tickets`),
        !pdf && xlsxCheckbox.checked ? api.get(`/api/events/${eventId}/card/xlsx`) : { groups: [] },
      ]);
      const tickets = filterTickets(all, option?.scope);
      if (tickets.length === 0) { progress.textContent = t('card.noUuidsDot'); return; }
      const onProgress = (done, total) => { progress.textContent = t('card.generating', { i: done, total }); };
      const archive = pdf
        ? new Blob([await exportPdf({ tickets, renderJpeg, signal, onProgress })], { type: 'application/pdf' })
        : await exportZip({
          tickets, renderCard, signal, JSZip: window.JSZip, xlsxGroups: sheets.groups, onProgress,
          onPack: () => { progress.textContent = t('card.packingZip'); },
        });
      const suffix = option ? `-${safeName(option.subsection ? `${option.section}-${option.subsection}` : option.section)}` : '';
      saveBlob(archive, `Einlasskarten-${safeName(cfg.event)}${suffix}.${pdf ? 'pdf' : 'zip'}`);
      progress.textContent = t('card.doneCount', { n: tickets.length });
    } catch (err) {
      if (err.name === 'AbortError') {
        progress.textContent = t('card.cancelled');
      } else {
        progress.textContent = '';
        alert(err.message);
      }
    } finally {
      setBusy(false);
      controller = null;
    }
  });

  content.replaceChildren(
    el('button', { class: 'btn secondary sm', onclick: () => history.back() }, t('common.back')),
    el('div', { class: 'section-head' }, el('h2', {}, t('card.heading', { name: cfg.event }))),
    el('div', { class: 'card-editor' },
      el('div', { class: 'card-controls' },
        el('label', { class: 'field' }, el('span', {}, t('card.title')), titleInput),
        el('div', { class: 'field' },
          el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:5px' },
            el('span', { style: 'margin:0' }, t('card.text')),
            boldBtn,
            el('span', { class: 'muted', style: 'font-size:12px' }, t('card.boldHint'))),
          textInput),
        el('div', { class: 'field' },
          el('span', {}, t('card.backdrop')),
          el('div', { class: 'inline-form', style: 'flex-wrap:wrap' }, fileInput, uploadBtn, removeBtn)),
        el('p', { class: 'muted', style: 'font-size:12.5px' }, t('card.explain')),
        el('label', { class: 'field' }, el('span', {}, t('card.scope')), scopeSelect),
        el('label', { class: 'field' }, el('span', {}, t('card.format')), formatSelect),
        el('div', { style: 'margin:8px 0' }, xlsxLabel),
        el('div', { class: 'inline-form', style: 'flex-wrap:wrap;margin-top:6px' },
          saveBtn, singleBtn, bulkBtn, cancelBtn),
        el('div', { style: 'margin-top:8px' }, progress)),
      el('div', { class: 'card-preview-wrap' }, canvas)));

  preview();
  loadBackdrop();
  return () => controller?.abort(); // leaving the page ends a running export instead of downloading it later
}
