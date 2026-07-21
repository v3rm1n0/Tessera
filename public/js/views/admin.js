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

  // --- create user
  const uName = el('input', { type: 'text', placeholder: 'Benutzername', autocomplete: 'off' });
  const uPass = el('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'new-password' });
  const uRole = el('select', {},
    el('option', { value: 'SCANNER' }, 'Scanner'),
    el('option', { value: 'EVENT_ADMIN' }, 'Event-Admin'));
  const uForm = el('form', { class: 'inline-form' },
    uName, uPass, uRole,
    el('button', { class: 'btn', type: 'submit' }, 'Konto anlegen'));
  uForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/admin/users', {
        username: uName.value, password: uPass.value, role: uRole.value,
      });
      reload();
    } catch (err) { flash(err); }
  });

  // --- user list with assignments
  const userRows = users.filter(u => u.role !== 'OWNER').map(u => {
    const assignSelect = el('select', { style: 'width:auto' },
      el('option', { value: '' }, 'Event zuweisen …'),
      events.filter(ev => !u.event_ids.includes(ev.id))
        .map(ev => el('option', { value: ev.id }, ev.name)));
    assignSelect.addEventListener('change', async () => {
      if (!assignSelect.value) return;
      try {
        await api.post(`/api/admin/events/${assignSelect.value}/assignments`, { userId: u.id });
        reload();
      } catch (err) { flash(err); }
    });
    return el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, u.username),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${u.role === 'EVENT_ADMIN' ? 'Event-Admin' : 'Scanner'} · `,
          u.event_ids.length === 0 ? 'keine Events' : '',
          ...u.event_ids.map(id => {
            const ev = events.find(e => e.id === id);
            const chip = el('a', { href: '#', title: 'Zuweisung entfernen' },
              `${ev?.name || id} ✕ `);
            chip.addEventListener('click', async e => {
              e.preventDefault();
              try {
                await api.del(`/api/admin/events/${id}/assignments/${u.id}`);
                reload();
              } catch (err) { flash(err); }
            });
            return chip;
          }))),
      assignSelect,
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(`Konto „${u.username}" löschen?`)) return;
          try { await api.del(`/api/admin/users/${u.id}`); reload(); } catch (err) { flash(err); }
        },
      }, 'Löschen'));
  });

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, 'Events (Owner)')),
    evForm,
    events.length > 0
      ? el('div', { class: 'list', style: 'margin-top:12px' },
          events.map(ev => el('div', { class: 'row' },
            el('div', { class: 'grow title' }, ev.name),
            el('span', { class: 'muted' }, `Reset ${ev.reset_time}`),
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
            }, 'Löschen'))))
      : null,
    el('div', { class: 'section-head' }, el('h2', {}, 'Konten (Owner)')),
    uForm,
    userRows.length > 0
      ? el('div', { class: 'list', style: 'margin-top:12px' }, userRows)
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
    const genBtn = el('button', { class: 'btn sm' }, 'UUIDs erzeugen');
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      try {
        const r = await api.post(`/api/sections/${s.id}/tickets`, { count: Number(count.value) });
        alert(`${r.created} UUIDs für „${s.name}" erzeugt.`);
        reload();
      } catch (err) { flash(err); genBtn.disabled = false; }
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
      count, genBtn,
      el('a', { class: 'btn secondary sm', href: tokenized(`/api/sections/${s.id}/qrcodes.zip`) }, 'QR · ZIP'),
      el('a', { class: 'btn secondary sm', href: tokenized(`/api/sections/${s.id}/qrcodes/print`), target: '_blank' }, 'QR · Drucken'),
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(`Abteilung „${s.name}" mit allen Codes löschen?`)) return;
          try { await api.del(`/api/sections/${s.id}`); reload(); } catch (err) { flash(err); }
        },
      }, '✕'));
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
