import { api } from '../api.js';
import { activeToken } from '../session.js';
import { el, state, currentEvent, refreshUser } from '../app.js';

/**
 * Verwaltung. Owner: accounts, events, assignments. EventAdmin: sections,
 * UUIDs, QR codes, reset time of the assigned event — Owner has no access
 * to those, section/code management belongs to the event admins alone.
 */
export async function renderAdmin(content) {
  const container = el('div', {});
  content.replaceChildren(container);

  async function load() {
    container.replaceChildren(state.user.role === 'OWNER'
      ? await ownerBlock(load)
      : await eventBlock(load));
  }
  await load();
}

/** Download links cannot send an Authorization header → token as query. */
function tokenized(url) {
  return `${url}?token=${encodeURIComponent(activeToken() || '')}`;
}

function flash(err) {
  alert(err.message || String(err));
}

// ================================================================== OWNER

async function ownerBlock(reload) {
  const [users, events] = await Promise.all([
    api.get('/api/admin/users'),
    api.get('/api/admin/events'),
  ]);
  const accounts = users.filter(u => u.role !== 'OWNER');

  // --- create event
  const evName = el('input', { type: 'text', placeholder: 'Event-Name' });
  const evForm = el('form', { class: 'inline-form' },
    evName,
    el('button', { class: 'btn', type: 'submit' }, 'Event anlegen'));
  evForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/admin/events', { name: evName.value });
      await refreshUser();
      reload();
    } catch (err) { flash(err); }
  });

  // --- one card per event: its accounts live here
  const eventCards = events.map(ev => {
    const assigned = accounts.filter(u => u.event_ids.includes(ev.id));
    const unassigned = accounts.filter(u => !u.event_ids.includes(ev.id));

    const memberChips = assigned.map(u => {
      const chip = el('button', {
        class: 'btn secondary sm', type: 'button',
        title: 'Zuweisung entfernen',
      }, `${u.username} (${u.role === 'EVENT_ADMIN' ? 'Admin' : 'Scanner'}) ✕`);
      chip.addEventListener('click', async () => {
        if (!confirm(`„${u.username}" von „${ev.name}" entfernen?`)) return;
        try { await api.del(`/api/admin/events/${ev.id}/assignments/${u.id}`); reload(); }
        catch (err) { flash(err); }
      });
      return chip;
    });

    // create a new account directly inside the event
    const nName = el('input', { type: 'text', placeholder: 'Benutzername', autocomplete: 'off' });
    const nPass = el('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'new-password' });
    const nRole = el('select', { style: 'width:auto' },
      el('option', { value: 'SCANNER' }, 'Scanner'),
      el('option', { value: 'EVENT_ADMIN' }, 'Event-Admin'));
    const createForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' },
      nName, nPass, nRole,
      el('button', { class: 'btn sm', type: 'submit' }, '+ Konto'));
    createForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api.post(`/api/admin/events/${ev.id}/users`, {
          username: nName.value, password: nPass.value, role: nRole.value,
        });
        reload();
      } catch (err) { flash(err); }
    });

    // or pull in an already existing account
    const addExisting = el('select', { style: 'width:auto' },
      el('option', { value: '' }, 'Bestehendes Konto zuweisen …'),
      unassigned.map(u => el('option', { value: u.id },
        `${u.username} (${u.role === 'EVENT_ADMIN' ? 'Admin' : 'Scanner'})`)));
    addExisting.addEventListener('change', async () => {
      if (!addExisting.value) return;
      try {
        await api.post(`/api/admin/events/${ev.id}/assignments`, { userId: Number(addExisting.value) });
        reload();
      } catch (err) { flash(err); }
    });

    return el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px' },
        el('div', { class: 'title', style: 'flex:1;font-weight:600' }, ev.name),
        el('span', { class: 'muted', style: 'font-size:12.5px' }, `Reset ${ev.reset_time}`),
        el('button', {
          class: 'btn danger sm',
          onclick: async () => {
            if (!confirm(`Event „${ev.name}" mit allen Daten löschen?`)) return;
            try {
              await api.del(`/api/admin/events/${ev.id}`);
              await refreshUser();
              reload();
            } catch (err) { flash(err); }
          },
        }, 'Löschen')),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px' },
        memberChips.length > 0 ? memberChips
          : el('span', { class: 'muted', style: 'font-size:13px' }, 'Noch keine Konten zugewiesen.')),
      createForm,
      unassigned.length > 0 ? el('div', { style: 'margin-top:8px' }, addExisting) : null);
  });

  // --- account housekeeping (delete accounts entirely)
  const accountRows = accounts.map(u =>
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, u.username),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${u.role === 'EVENT_ADMIN' ? 'Event-Admin' : 'Scanner'} · ${
            u.event_ids.length === 0 ? 'keine Events'
              : u.event_ids.map(id => events.find(e => e.id === id)?.name || id).join(', ')}`)),
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(`Konto „${u.username}" endgültig löschen?`)) return;
          try { await api.del(`/api/admin/users/${u.id}`); reload(); } catch (err) { flash(err); }
        },
      }, 'Löschen')));

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, 'Events')),
    evForm,
    el('div', { style: 'margin-top:12px' },
      eventCards.length > 0 ? eventCards
        : el('div', { class: 'empty' }, 'Noch keine Events angelegt.')),
    el('div', { class: 'section-head' }, el('h2', {}, 'Alle Konten')),
    accountRows.length > 0
      ? el('div', { class: 'list' }, accountRows)
      : el('div', { class: 'empty' }, 'Noch keine Konten angelegt.'));
}

// ============================================================ EVENT ADMIN

async function eventBlock(reload) {
  const event = currentEvent();
  if (!event) {
    return el('div', { class: 'empty' }, 'Kein Event ausgewählt.');
  }
  const dash = await api.get(`/api/events/${event.id}/dashboard`);

  // --- reset time
  const resetInput = el('input', { type: 'time', value: dash.event.reset_time, style: 'width:auto' });
  const resetForm = el('form', { class: 'inline-form' },
    resetInput,
    el('button', { class: 'btn secondary', type: 'submit' }, 'Reset-Zeit speichern'));
  resetForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.patch(`/api/events/${event.id}`, { reset_time: resetInput.value });
      await refreshUser();
      reload();
    } catch (err) { flash(err); }
  });

  // --- new section
  const secName = el('input', { type: 'text', placeholder: 'Name der Abteilung' });
  const secForm = el('form', { class: 'inline-form' },
    secName,
    el('button', { class: 'btn', type: 'submit' }, 'Abteilung anlegen'));
  secForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post(`/api/events/${event.id}/sections`, { name: secName.value });
      reload();
    } catch (err) { flash(err); }
  });

  // --- section rows with ticket generation + QR/export actions
  const sectionRows = dash.sections.map(s => {
    const count = el('input', {
      type: 'number', min: '1', max: '10000', value: '50', style: 'width:90px',
    });
    const subSelect = el('select', { style: 'width:auto' },
      el('option', { value: '' }, 'Ohne Unterabteilung'),
      s.subsections.map(sub => el('option', { value: sub.id }, sub.name)));
    const genBtn = el('button', { class: 'btn sm' }, 'UUIDs erzeugen');
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      try {
        const r = await api.post(`/api/sections/${s.id}/tickets`, {
          count: Number(count.value),
          ...(subSelect.value ? { subsection_id: Number(subSelect.value) } : {}),
        });
        const subName = subSelect.selectedOptions[0]?.textContent;
        alert(`${r.created} UUIDs für „${subSelect.value ? `${s.name} – ${subName}` : s.name}" erzeugt.`);
        reload();
      } catch (err) { flash(err); genBtn.disabled = false; }
    });

    // subsection chips + add form
    const subName = el('input', { type: 'text', placeholder: 'Neue Unterabteilung', style: 'max-width:220px' });
    const subForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' },
      ...s.subsections.map(sub => {
        const chip = el('button', {
          type: 'button', class: 'btn secondary sm',
          title: 'Unterabteilung löschen',
        }, `${sub.name} ✕`);
        chip.addEventListener('click', async () => {
          if (!confirm(`Unterabteilung „${sub.name}" löschen?`)) return;
          try { await api.del(`/api/subsections/${sub.id}`); reload(); }
          catch (err) { flash(err); }
        });
        return chip;
      }),
      subName,
      el('button', { class: 'btn secondary sm', type: 'submit' }, '+ Hinzufügen'));
    subForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api.post(`/api/sections/${s.id}/subsections`, { name: subName.value });
        reload();
      } catch (err) { flash(err); }
    });
    const colorInput = el('input', {
      type: 'color', class: 'color-input', value: s.color,
      title: 'Farbe der Abteilung',
    });
    colorInput.addEventListener('change', async () => {
      try { await api.patch(`/api/sections/${s.id}`, { color: colorInput.value }); reload(); }
      catch (err) { flash(err); }
    });
    return el('div', { class: 'row', style: 'flex-wrap:wrap' },
      colorInput,
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, s.name),
        el('div', { class: 'muted', style: 'font-size:12.5px' }, `${s.ticket_count} Codes`)),
      count, subSelect, genBtn,
      el('a', { class: 'btn secondary sm', href: tokenized(`/api/sections/${s.id}/qrcodes.zip`) }, 'QR · ZIP'),
      el('a', { class: 'btn secondary sm', href: tokenized(`/api/sections/${s.id}/qrcodes/print`), target: '_blank' }, 'QR · Drucken'),
      el('button', {
        class: 'btn secondary sm',
        onclick: () => { location.hash = `#/karte/${s.id}`; },
      }, '🎟 Einlasskarte'),
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(`Abteilung „${s.name}" mit allen Codes löschen?`)) return;
          try { await api.del(`/api/sections/${s.id}`); reload(); } catch (err) { flash(err); }
        },
      }, '✕'),
      el('div', { style: 'flex-basis:100%;margin-top:8px' }, subForm));
  });

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, `Event: ${event.name}`)),
    el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'label', style: 'margin-bottom:8px' },
        'Täglicher Reset der Scan-Zähler'),
      resetForm),
    el('div', { class: 'card' },
      el('div', { class: 'label', style: 'margin-bottom:8px' }, 'Abteilungen'),
      secForm,
      sectionRows.length > 0
        ? el('div', { class: 'list', style: 'margin-top:12px' }, sectionRows)
        : el('div', { class: 'empty' }, 'Noch keine Abteilungen.'),
      el('div', { style: 'margin-top:12px' },
        el('a', { class: 'btn secondary sm', href: tokenized(`/api/events/${event.id}/tickets.xlsx`) },
          '⬇ Alle UUIDs als Excel'))));
}
