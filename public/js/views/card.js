import { api } from '../api.js';
import { activeToken } from '../session.js';
import { el } from '../app.js';
import { CARD_W, CARD_H, drawCard, qrMatrix } from '../card-render.js';

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const safe = s => s.replace(/[^\p{L}\p{N}_-]+/gu, '_');

/**
 * Einlasskarten editor (EVENT_ADMIN). The card is defined once per event;
 * every ticket of every section is exported at once as PNGs in a ZIP,
 * each using its section color and "Section – Subsection" label.
 */
export async function renderCardEditor(content, eventId) {
  let cfg;
  try {
    cfg = await api.get(`/api/events/${eventId}/card`);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'error-text' }, err.message));
    return;
  }

  const sample = cfg.sample || { color: '#4f9cf5', label: 'Abteilung' };
  let backdropImg = null;

  // ---- controls
  const titleInput = el('input', {
    type: 'text', maxlength: '200',
    value: cfg.title || 'VOREINLASS-AUSWEIS',
  });
  const textInput = el('textarea', {
    rows: '11', maxlength: '4000',
    placeholder: 'Text der Einlasskarte …',
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
      backdropImg,
      matrix: qrMatrix(PLACEHOLDER_UUID),
    });
  }
  titleInput.addEventListener('input', preview);
  textInput.addEventListener('input', preview);

  // wrap the current selection in **…** for bold
  const boldBtn = el('button', { type: 'button', class: 'btn secondary sm', title: 'Auswahl fett' }, 'F');
  boldBtn.style.fontWeight = '800';
  boldBtn.addEventListener('click', () => {
    const start = textInput.selectionStart;
    const end = textInput.selectionEnd;
    const v = textInput.value;
    const sel = v.slice(start, end) || 'Text';
    textInput.value = `${v.slice(0, start)}**${sel}**${v.slice(end)}`;
    textInput.focus();
    textInput.setSelectionRange(start + 2, start + 2 + sel.length);
    preview();
  });

  // ---- save config
  const saveBtn = el('button', { class: 'btn' }, 'Speichern');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.put(`/api/events/${eventId}/card`, { title: titleInput.value, text: textInput.value });
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
    img.src = `/api/events/${eventId}/card/backdrop`
      + `?token=${encodeURIComponent(activeToken() || '')}&t=${Date.now()}`;
  }

  const fileInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none',
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { alert('Bild ist zu groß (max. 8 MB).'); fileInput.value = ''; return; }
    try {
      const res = await fetch(`/api/events/${eventId}/card/backdrop`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: `Bearer ${activeToken()}` },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload fehlgeschlagen');
      cfg.has_backdrop = true;
      removeBtn.style.display = '';
      loadBackdrop();
    } catch (err) { alert(err.message); }
    fileInput.value = '';
  });

  const uploadBtn = el('button', { class: 'btn secondary' }, '🖼 Hintergrundbild wählen');
  uploadBtn.addEventListener('click', () => fileInput.click());
  const removeBtn = el('button', {
    class: 'btn secondary sm',
    style: cfg.has_backdrop ? '' : 'display:none',
  }, 'Bild entfernen');
  removeBtn.addEventListener('click', async () => {
    try {
      await api.del(`/api/events/${eventId}/card/backdrop`);
      cfg.has_backdrop = false; backdropImg = null; removeBtn.style.display = 'none'; preview();
    } catch (err) { alert(err.message); }
  });

  // ---- export
  const progress = el('span', { class: 'muted', style: 'font-size:13px' });

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const singleBtn = el('button', { class: 'btn secondary' }, 'Vorschau als PNG');
  singleBtn.addEventListener('click', () => {
    const off = document.createElement('canvas');
    off.width = CARD_W; off.height = CARD_H;
    drawCard(off.getContext('2d'), {
      color: sample.color, title: titleInput.value, text: textInput.value,
      label: sample.label, backdropImg, matrix: qrMatrix(PLACEHOLDER_UUID),
    });
    off.toBlob(blob => download(blob, `Einlasskarte-${safe(cfg.event)}-vorschau.png`), 'image/png');
  });

  // optional: drop a UUID-list Excel into each section/subsection folder
  const xlsxCheckbox = el('input', { type: 'checkbox', id: 'incl-xlsx', style: 'width:auto;margin:0' });
  const xlsxLabel = el('label', {
    for: 'incl-xlsx',
    style: 'display:flex;align-items:center;gap:8px;margin:0;color:var(--text);cursor:pointer;font-size:13.5px',
  }, xlsxCheckbox, 'Excel-Liste (UUIDs zum Abhaken) je Ordner beilegen');

  const bulkBtn = el('button', { class: 'btn' },
    cfg.total_tickets ? `Alle ${cfg.total_tickets} Karten als PNG (ZIP)` : 'Keine UUIDs vorhanden');
  bulkBtn.disabled = cfg.total_tickets === 0;
  bulkBtn.addEventListener('click', async () => {
    bulkBtn.disabled = true;
    progress.textContent = 'Lade UUIDs …';
    try {
      const tickets = await api.get(`/api/events/${eventId}/card/tickets`);
      if (tickets.length === 0) { progress.textContent = 'Keine UUIDs vorhanden.'; return; }
      const zip = new window.JSZip();
      const off = document.createElement('canvas');
      off.width = CARD_W; off.height = CARD_H;
      const octx = off.getContext('2d');
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const label = t.subsection ? `${t.section} – ${t.subsection}` : t.section;
        drawCard(octx, {
          color: t.color, title: titleInput.value, text: textInput.value,
          label, backdropImg, matrix: qrMatrix(t.uuid),
        });
        const blob = await new Promise(r => off.toBlob(r, 'image/png'));
        // dedicated folder per section, subfolder per subsection
        const dir = t.subsection
          ? zip.folder(safe(t.section)).folder(safe(t.subsection))
          : zip.folder(safe(t.section));
        dir.file(`${t.uuid}.png`, blob);
        progress.textContent = `Erzeuge ${i + 1}/${tickets.length} …`;
        if (i % 8 === 0) await new Promise(r => setTimeout(r));
      }
      if (xlsxCheckbox.checked) {
        progress.textContent = 'Erzeuge Excel-Listen …';
        const { groups } = await api.get(`/api/events/${eventId}/card/xlsx`);
        for (const g of groups) {
          const bytes = Uint8Array.from(atob(g.base64), c => c.charCodeAt(0));
          const dir = g.subsection
            ? zip.folder(safe(g.section)).folder(safe(g.subsection))
            : zip.folder(safe(g.section));
          dir.file('UUIDs.xlsx', bytes);
        }
      }
      progress.textContent = 'Packe ZIP …';
      const out = await zip.generateAsync({ type: 'blob' });
      download(out, `Einlasskarten-${safe(cfg.event)}.zip`);
      progress.textContent = `${tickets.length} Karten erzeugt.`;
    } catch (err) {
      progress.textContent = '';
      alert(err.message);
    }
    bulkBtn.disabled = false;
  });

  // ---- layout
  content.replaceChildren(
    el('button', { class: 'btn secondary sm', onclick: () => history.back() }, '← Zurück'),
    el('div', { class: 'section-head' }, el('h2', {}, `Einlasskarte – ${cfg.event}`)),
    el('div', { class: 'card-editor' },
      el('div', { class: 'card-controls' },
        el('label', { class: 'field' }, el('span', {}, 'Titel'), titleInput),
        el('div', { class: 'field' },
          el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:5px' },
            el('span', { style: 'margin:0' }, 'Text'),
            boldBtn,
            el('span', { class: 'muted', style: 'font-size:12px' }, 'oder **…** für Fettdruck')),
          textInput),
        el('div', { class: 'field' },
          el('span', {}, 'Hintergrundbild'),
          el('div', { class: 'inline-form', style: 'flex-wrap:wrap' }, fileInput, uploadBtn, removeBtn)),
        el('p', { class: 'muted', style: 'font-size:12.5px' },
          'Einmal definiert – gilt für alle Abteilungen. Hauptfarbe, QR-Code und '
          + 'Beschriftung (Abteilung – Unterabteilung) werden pro UUID automatisch eingesetzt.'),
        el('div', { style: 'margin:8px 0' }, xlsxLabel),
        el('div', { class: 'inline-form', style: 'flex-wrap:wrap;margin-top:6px' },
          saveBtn, singleBtn, bulkBtn),
        el('div', { style: 'margin-top:8px' }, progress)),
      el('div', { class: 'card-preview-wrap' }, canvas)));

  preview();
  loadBackdrop();
}
