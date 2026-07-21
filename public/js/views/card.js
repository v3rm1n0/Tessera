import { api } from '../api.js';
import { activeToken } from '../session.js';
import { el } from '../app.js';
import { CARD_W, CARD_H, drawCard, qrMatrix } from '../card-render.js';

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const safe = s => s.replace(/[^\p{L}\p{N}_-]+/gu, '_');

/** Einlasskarten editor: live preview + bulk PNG export (EVENT_ADMIN only). */
export async function renderCardEditor(content, sectionId) {
  let cfg, tickets;
  try {
    [cfg, tickets] = await Promise.all([
      api.get(`/api/sections/${sectionId}/card`),
      api.get(`/api/sections/${sectionId}/tickets`),
    ]);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  let backdropImg = null;

  const labelFor = t => (t?.subsection ? `${cfg.section} – ${t.subsection}` : cfg.section);

  // ---- controls
  const titleInput = el('input', {
    type: 'text', maxlength: '200',
    value: cfg.title || 'VOREINLASS-AUSWEIS',
  });
  const textInput = el('textarea', {
    rows: '10', maxlength: '4000',
    placeholder: 'Text der Einlasskarte …',
  });
  textInput.value = cfg.text || '';

  const canvas = el('canvas', { class: 'card-preview' });
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');

  function preview() {
    const sample = tickets[0];
    drawCard(ctx, {
      color: cfg.color,
      title: titleInput.value,
      text: textInput.value,
      label: labelFor(sample),
      backdropImg,
      matrix: qrMatrix(sample ? sample.uuid : PLACEHOLDER_UUID),
    });
  }

  titleInput.addEventListener('input', preview);
  textInput.addEventListener('input', preview);

  // ---- save config
  const saveBtn = el('button', { class: 'btn' }, 'Speichern');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.put(`/api/sections/${sectionId}/card`, {
        title: titleInput.value, text: textInput.value,
      });
      cfg.title = titleInput.value;
      cfg.text = textInput.value;
      saveBtn.textContent = 'Gespeichert ✓';
      setTimeout(() => { saveBtn.textContent = 'Speichern'; saveBtn.disabled = false; }, 1200);
    } catch (err) { alert(err.message); saveBtn.disabled = false; }
  });

  // ---- backdrop
  function loadBackdrop() {
    if (!cfg.has_backdrop) { backdropImg = null; preview(); return; }
    const img = new Image();
    img.onload = () => { backdropImg = img; preview(); };
    img.onerror = () => { backdropImg = null; preview(); };
    img.src = `/api/sections/${sectionId}/card/backdrop`
      + `?token=${encodeURIComponent(activeToken() || '')}&t=${Date.now()}`;
  }

  const fileInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp',
    style: 'display:none',
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { alert('Bild ist zu groß (max. 8 MB).'); fileInput.value = ''; return; }
    try {
      const res = await fetch(`/api/sections/${sectionId}/card/backdrop`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: `Bearer ${activeToken()}` },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload fehlgeschlagen');
      cfg.has_backdrop = true;
      loadBackdrop();
    } catch (err) { alert(err.message); }
    fileInput.value = '';
  });

  const uploadBtn = el('button', { class: 'btn secondary' }, '🖼 Hintergrundbild wählen');
  uploadBtn.addEventListener('click', () => fileInput.click());
  const removeBtn = el('button', { class: 'btn secondary sm' }, 'Bild entfernen');
  removeBtn.addEventListener('click', async () => {
    try {
      await api.del(`/api/sections/${sectionId}/card/backdrop`);
      cfg.has_backdrop = false; backdropImg = null; preview();
    } catch (err) { alert(err.message); }
  });

  // ---- export
  const progress = el('span', { class: 'muted', style: 'font-size:13px' });

  async function renderTicketBlob(octx, offCanvas, t) {
    drawCard(octx, {
      color: cfg.color,
      title: titleInput.value,
      text: textInput.value,
      label: labelFor(t),
      backdropImg,
      matrix: qrMatrix(t.uuid),
    });
    return new Promise(resolve => offCanvas.toBlob(resolve, 'image/png'));
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const singleBtn = el('button', { class: 'btn secondary' }, 'Vorschau als PNG');
  singleBtn.addEventListener('click', async () => {
    const off = document.createElement('canvas');
    off.width = CARD_W; off.height = CARD_H;
    const blob = await renderTicketBlob(off.getContext('2d'), off, tickets[0] || null);
    download(blob, `Einlasskarte-${safe(cfg.section)}-vorschau.png`);
  });

  const bulkBtn = el('button', { class: 'btn' },
    tickets.length ? `Alle ${tickets.length} als PNG (ZIP)` : 'Keine UUIDs vorhanden');
  bulkBtn.disabled = tickets.length === 0;
  bulkBtn.addEventListener('click', async () => {
    bulkBtn.disabled = true;
    const zip = new window.JSZip();
    const off = document.createElement('canvas');
    off.width = CARD_W; off.height = CARD_H;
    const octx = off.getContext('2d');
    try {
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const blob = await renderTicketBlob(octx, off, t);
        zip.file(`${safe(labelFor(t))}-${t.uuid}.png`, blob);
        progress.textContent = `Erzeuge ${i + 1}/${tickets.length} …`;
        if (i % 8 === 0) await new Promise(r => setTimeout(r)); // keep UI responsive
      }
      progress.textContent = 'Packe ZIP …';
      const out = await zip.generateAsync({ type: 'blob' });
      download(out, `Einlasskarten-${safe(cfg.section)}.zip`);
      progress.textContent = `${tickets.length} PNG erzeugt.`;
    } catch (err) {
      progress.textContent = '';
      alert(err.message);
    }
    bulkBtn.disabled = false;
  });

  // ---- layout
  content.replaceChildren(
    el('button', { class: 'btn secondary sm', onclick: () => history.back() }, '← Zurück'),
    el('div', { class: 'section-head' },
      el('span', { class: 'color-dot', style: `background:${cfg.color};width:16px;height:16px` }),
      el('h2', {}, `Einlasskarte – ${cfg.section}`)),
    el('div', { class: 'card-editor' },
      el('div', { class: 'card-controls' },
        el('label', { class: 'field' }, el('span', {}, 'Titel'), titleInput),
        el('label', { class: 'field' }, el('span', {}, 'Text'), textInput),
        el('div', { class: 'field' },
          el('span', {}, 'Hintergrundbild'),
          el('div', { class: 'inline-form', style: 'flex-wrap:wrap' },
            fileInput, uploadBtn,
            cfg.has_backdrop ? removeBtn : null)),
        el('p', { class: 'muted', style: 'font-size:12.5px' },
          'Die Hauptfarbe stammt aus der Abteilung. QR-Code und Beschriftung '
          + '(Abteilung – Unterabteilung) werden pro UUID automatisch eingesetzt.'),
        el('div', { class: 'inline-form', style: 'flex-wrap:wrap;margin-top:6px' },
          saveBtn, singleBtn, bulkBtn),
        el('div', { style: 'margin-top:8px' }, progress)),
      el('div', { class: 'card-preview-wrap' }, canvas)));

  preview();
  loadBackdrop();
}
