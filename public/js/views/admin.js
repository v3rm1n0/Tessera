import { api } from '../api.js';
import { downloadFile } from '../download.js';
import { editableName, passwordInput } from '../ui.js';
import { generatePassword } from '../password.js';
import { el, state, currentEvent, refreshUser } from '../app.js';
import { t, hasKey, dateLocale, getLang } from '../i18n.js';

/** Administration: Owner manages accounts/events/assignments; Event Admin manages sections, UUIDs and reset time. */
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

/** Suggestions for the time zone field: every IANA zone the browser knows, plus UTC. */
function zoneList() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return el('datalist', { id: 'tz-list' },
    ['UTC', ...zones.filter(zone => zone !== 'UTC')].map(zone => el('option', { value: zone })));
}

function flash(err) {
  alert(err.message || String(err));
}

async function ownerBlock(reload) {
  const [users, events] = await Promise.all([
    api.get('/api/admin/users'),
    api.get('/api/admin/events'),
  ]);
  const accounts = users.filter(u => u.role !== 'OWNER');

  const evName = el('input', { type: 'text', placeholder: t('admin.eventNamePh') });
  const evForm = el('form', { class: 'inline-form' },
    evName,
    el('button', { class: 'btn', type: 'submit' }, t('admin.createEvent')));
  evForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/admin/events', { name: evName.value });
      await refreshUser();
      reload();
    } catch (err) { flash(err); }
  });

  const renderEvent = ev => {
    const archived = Boolean(ev.archived_at);
    const assigned = accounts.filter(u => u.event_ids.includes(ev.id));
    const unassigned = accounts.filter(u => !u.event_ids.includes(ev.id));

    const memberChips = assigned.map(u => {
      const chip = el('button', {
        class: 'btn secondary sm', type: 'button',
        title: t('admin.removeAssignment'),
      }, `${u.username} (${u.role === 'EVENT_ADMIN' ? t('admin.roleAdminShort') : t('admin.roleScanner')}) ✕`);
      chip.addEventListener('click', async () => {
        if (!confirm(t('admin.confirmRemove', { user: u.username, event: ev.name }))) return;
        try { await api.del(`/api/admin/events/${ev.id}/assignments/${u.id}`); reload(); }
        catch (err) { flash(err); }
      });
      return chip;
    });

    const nName = el('input', { type: 'text', placeholder: t('admin.usernamePh'), autocomplete: 'off' });
    const { input: nPass, generate: nGenerate } = passwordInput({ placeholder: t('admin.passwordPh') });
    const nRole = el('select', { style: 'width:auto' },
      el('option', { value: 'SCANNER' }, t('role.SCANNER')),
      el('option', { value: 'EVENT_ADMIN' }, t('role.EVENT_ADMIN')));
    const createForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' },
      nName, nPass, nGenerate, nRole,
      el('button', { class: 'btn sm', type: 'submit' }, t('admin.addAccount')));
    createForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api.post(`/api/admin/events/${ev.id}/users`, {
          username: nName.value, password: nPass.value, role: nRole.value,
        });
        reload();
      } catch (err) { flash(err); }
    });

    const addExisting = el('select', { style: 'width:auto' },
      el('option', { value: '' }, t('admin.assignExisting')),
      unassigned.map(u => el('option', { value: u.id },
        `${u.username} (${u.role === 'EVENT_ADMIN' ? t('admin.roleAdminShort') : t('admin.roleScanner')})`)));
    addExisting.addEventListener('change', async () => {
      if (!addExisting.value) return;
      try {
        await api.post(`/api/admin/events/${ev.id}/assignments`, { userId: Number(addExisting.value) });
        reload();
      } catch (err) { flash(err); }
    });

    const startInput = el('input', { type: 'date', value: ev.start_date, 'aria-label': t('admin.startDate'), style: 'width:auto' });
    const endInput = el('input', { type: 'date', value: ev.end_date, 'aria-label': t('admin.endDate'), style: 'width:auto' });
    const datesForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap;margin-bottom:10px' },
      el('span', { class: 'muted', style: 'font-size:12.5px' }, t('admin.dates')),
      startInput, el('span', { class: 'muted' }, '–'), endInput,
      el('button', { class: 'btn secondary sm', type: 'submit' }, t('admin.saveDates')));
    datesForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api.patch(`/api/admin/events/${ev.id}`, { start_date: startInput.value, end_date: endInput.value });
        await refreshUser();
        reload();
      } catch (err) { flash(err); }
    });

    return el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap' },
        editableName({
          attrs: { class: 'title', style: 'font-weight:600' }, name: ev.name, wrapStyle: 'flex:1',
          onSave: async name => { await api.patch(`/api/admin/events/${ev.id}`, { name }); await refreshUser(); reload(); },
        }),
        archived ? el('span', { class: 'badge warn' }, t('event.archivedBadge')) : null,
        el('span', { class: 'muted', style: 'font-size:12.5px' }, t('admin.reset', { time: ev.reset_time })),
        el('button', {
          class: 'btn secondary sm', type: 'button',
          onclick: async () => {
            if (!archived && !confirm(t('admin.confirmArchive', { event: ev.name }))) return;
            try {
              await api.patch(`/api/admin/events/${ev.id}`, { archived: !archived });
              await refreshUser();
              reload();
            } catch (err) { flash(err); }
          },
        }, archived ? t('admin.unarchive') : t('admin.archive')),
        el('button', {
          class: 'btn danger sm',
          onclick: async () => {
            if (!confirm(t('admin.confirmDeleteEvent', { event: ev.name }))) return;
            try {
              await api.del(`/api/admin/events/${ev.id}`);
              await refreshUser();
              reload();
            } catch (err) { flash(err); }
          },
        }, t('common.delete'))),
      datesForm,
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px' },
        memberChips.length > 0 ? memberChips
          : el('span', { class: 'muted', style: 'font-size:13px' }, t('admin.noAccounts'))),
      createForm,
      unassigned.length > 0 ? el('div', { style: 'margin-top:8px' }, addExisting) : null);
  };
  const activeCards = events.filter(ev => !ev.archived_at).map(renderEvent);
  const archivedCards = events.filter(ev => ev.archived_at).map(renderEvent);

  const accountRows = accounts.map(u => {
    const panel = el('div', { style: 'display:none' });
    const toggleReset = () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (!open) panel.replaceChildren(resetPanel(u));
    };
    return el('div', { class: 'row-wrap' },
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, u.username),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${u.role === 'EVENT_ADMIN' ? t('role.EVENT_ADMIN') : t('role.SCANNER')} · ${
            u.event_ids.length === 0 ? t('admin.noEventsAssigned')
              : u.event_ids.map(id => events.find(e => e.id === id)?.name || id).join(', ')}`)),
      el('button', { class: 'btn secondary sm', type: 'button', onclick: toggleReset }, t('admin.resetPassword')),
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(t('admin.confirmDeleteAccount', { user: u.username }))) return;
          try { await api.del(`/api/admin/users/${u.id}`); reload(); } catch (err) { flash(err); }
        },
      }, t('common.delete'))),
    panel);
  });

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.eventsHead'))),
    evForm,
    el('div', { style: 'margin-top:12px' },
      activeCards.length > 0 ? activeCards
        : el('div', { class: 'empty' }, t('admin.noEvents'))),
    archivedCards.length > 0
      ? el('details', { class: 'archived-events' },
          el('summary', {}, t('admin.archivedHead', { n: archivedCards.length })),
          el('div', { style: 'margin-top:12px' }, archivedCards))
      : null,
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.allAccounts'))),
    accountRows.length > 0
      ? el('div', { class: 'list' }, accountRows)
      : el('div', { class: 'empty' }, t('admin.noAccountsAtAll')),
    await activityBlock());
}

/** Inline form of an account row: a generated password (editable) the Owner saves and hands over. */
function resetPanel(user) {
  const { input, generate } = passwordInput({ placeholder: t('admin.newPasswordFor', { user: user.username }) });
  input.type = 'text';
  input.value = generatePassword();
  const save = el('button', { class: 'btn sm', type: 'submit' }, t('common.save'));
  const copy = el('button', { class: 'btn secondary sm', type: 'button' }, t('admin.copy'));
  const note = el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:6px' });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(input.value); copy.textContent = t('admin.copied'); }
    catch { input.select(); }
  });
  const form = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' }, input, generate, copy, save);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api.patch(`/api/admin/users/${user.id}`, { password: input.value });
      note.className = 'muted';
      note.textContent = t('admin.passwordReset', { user: user.username });
    } catch (err) {
      save.disabled = false;
      flash(err);
    }
  });
  return el('div', { class: 'reset-panel' }, form, note);
}

const AUDIT_PAGE = 25;

/** Newest-first list of administrative actions with a "load more" button. */
async function activityBlock() {
  const list = el('div', { class: 'list' });
  const empty = el('div', { class: 'empty', style: 'display:none' }, t('admin.noActivity'));
  const more = el('button', { class: 'btn secondary sm', type: 'button', style: 'margin-top:10px;display:none' }, t('admin.loadMore'));
  let next = null;

  async function load() {
    const query = `?limit=${AUDIT_PAGE}${next ? `&before=${next}` : ''}`;
    const data = await api.get(`/api/admin/audit${query}`);
    list.append(...data.items.map(auditRow));
    next = data.next_before;
    more.style.display = next ? '' : 'none';
    empty.style.display = list.children.length === 0 ? '' : 'none';
  }
  more.addEventListener('click', () => load().catch(flash));
  await load();

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.activity'))),
    list, empty, more);
}

function auditRow(item) {
  const label = hasKey(`audit.${item.action}`) ? t(`audit.${item.action}`) : item.action;
  const details = item.details
    ? Object.entries(item.details).map(([key, value]) => `${key}: ${value}`).join(', ')
    : '';
  const meta = [item.username || '—', new Date(item.at).toLocaleString(dateLocale()), details].filter(Boolean).join(' · ');
  return el('div', { class: 'row' },
    el('div', { class: 'grow' },
      el('div', { class: 'title' }, item.target ? `${label} · ${item.target}` : label),
      el('div', { class: 'muted', style: 'font-size:12.5px' }, meta)));
}

async function eventBlock(reload) {
  const event = currentEvent();
  if (!event) {
    return el('div', { class: 'empty' }, t('admin.noEventSelected'));
  }
  const dash = await api.get(`/api/events/${event.id}/dashboard`);

  const resetInput = el('input', { type: 'time', value: dash.event.reset_time, style: 'width:auto' });
  const zoneInput = el('input', {
    type: 'text', list: 'tz-list', value: dash.event.timezone || '', placeholder: 'Europe/Berlin',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': t('admin.timezone'), style: 'width:auto;min-width:210px',
  });
  const resetForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' },
    resetInput, zoneInput, zoneList(),
    el('button', { class: 'btn secondary', type: 'submit' }, t('admin.saveResetTime')));
  resetForm.addEventListener('submit', async e => {
    e.preventDefault();
    const zone = zoneInput.value.trim();
    const changed = resetInput.value !== dash.event.reset_time || (zone && zone !== dash.event.timezone);
    // moving the day window changes what counts as "today" (and what is a duplicate) right away
    if (changed && !confirm(t('admin.confirmResetChange'))) return;
    try {
      await api.patch(`/api/events/${event.id}`, { reset_time: resetInput.value, ...(zone ? { timezone: zone } : {}) });
      await refreshUser();
      reload();
    } catch (err) { flash(err); }
  });

  const secName = el('input', { type: 'text', placeholder: t('admin.sectionNamePh') });
  const secForm = el('form', { class: 'inline-form' },
    secName,
    el('button', { class: 'btn', type: 'submit' }, t('admin.createSection')));
  secForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post(`/api/events/${event.id}/sections`, { name: secName.value });
      reload();
    } catch (err) { flash(err); }
  });

  // reusable count + generate-codes control
  function uuidGen(url, body) {
    const count = el('input', { type: 'number', min: '1', max: '10000', value: '50', style: 'width:78px' });
    const btn = el('button', { class: 'btn sm' }, t('admin.genCodes'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.post(url, { count: Number(count.value), ...body });
        reload();
      } catch (err) { flash(err); btn.disabled = false; }
    });
    return el('div', { class: 'inline-form', style: 'width:auto;flex:0 0 auto' }, count, btn);
  }

  const sectionCards = dash.sections.map(s => {
    const colorInput = el('input', {
      type: 'color', class: 'color-input', value: s.color, title: t('admin.sectionColor'),
    });
    colorInput.addEventListener('change', async () => {
      try { await api.patch(`/api/sections/${s.id}`, { color: colorInput.value }); reload(); }
      catch (err) { flash(err); }
    });

    const subTotal = s.subsections.reduce((n, x) => n + x.ticket_count, 0);
    const directCount = s.ticket_count - subTotal;

    const subCards = s.subsections.map(sub =>
      el('div', { class: 'subcard' },
        el('span', { class: 'color-dot', style: `background:${s.color};opacity:0.6` }),
        el('div', { class: 'grow' },
          editableName({
            attrs: { class: 'title', style: 'font-size:14px' }, name: sub.name,
            onSave: async name => { await api.patch(`/api/subsections/${sub.id}`, { name }); reload(); },
          }),
          el('div', { class: 'muted', style: 'font-size:12px' }, t('admin.subCodes', { n: sub.ticket_count }))),
        uuidGen(`/api/sections/${s.id}/tickets`, { subsection_id: sub.id }),
        el('button', {
          class: 'btn danger sm', title: t('admin.deleteSub'),
          onclick: async () => {
            if (!confirm(t('admin.confirmDeleteSub', { name: sub.name, n: sub.ticket_count }))) return;
            try { await api.del(`/api/subsections/${sub.id}`); reload(); } catch (err) { flash(err); }
          },
        }, '✕')));

    const subName = el('input', { type: 'text', placeholder: t('admin.newSubPh'), style: 'max-width:220px' });
    const subForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap;margin-top:8px' },
      subName, el('button', { class: 'btn secondary sm', type: 'submit' }, t('admin.addSub')));
    subForm.addEventListener('submit', async e => {
      e.preventDefault();
      try { await api.post(`/api/sections/${s.id}/subsections`, { name: subName.value }); reload(); }
      catch (err) { flash(err); }
    });

    return el('div', { class: 'card section-card' },
      el('div', { class: 'section-card-head' },
        colorInput,
        el('div', { class: 'grow' },
          editableName({
            attrs: { class: 'title' }, name: s.name,
            onSave: async name => { await api.patch(`/api/sections/${s.id}`, { name }); reload(); },
          }),
          el('div', { class: 'muted', style: 'font-size:12.5px' }, t('admin.codesTotal', { n: s.ticket_count }))),
        el('button', {
          class: 'btn danger sm',
          onclick: async () => {
            if (!confirm(t('admin.confirmDeleteSection', { name: s.name }))) return;
            try { await api.del(`/api/sections/${s.id}`); reload(); } catch (err) { flash(err); }
          },
        }, t('common.delete'))),
      el('div', { class: 'subcard direct' },
        el('div', { class: 'grow' },
          el('div', { class: 'title', style: 'font-size:14px' }, t('admin.noSubsection')),
          el('div', { class: 'muted', style: 'font-size:12px' }, t('admin.directCodes', { n: directCount }))),
        uuidGen(`/api/sections/${s.id}/tickets`, {})),
      subCards.length ? el('div', { class: 'subcards' }, subCards) : null,
      subForm);
  });

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.eventHead', { name: event.name }))),
    el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'label', style: 'margin-bottom:8px' },
        t('admin.dailyReset')),
      resetForm,
      el('p', { class: 'muted', style: 'font-size:12.5px;margin:8px 0 0' }, t('admin.resetHint'))),
    el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'label', style: 'margin-bottom:8px' }, t('admin.cardLabel')),
      el('div', { class: 'inline-form', style: 'flex-wrap:wrap' },
        el('button', {
          class: 'btn',
          onclick: () => { location.hash = `#/karte/${event.id}`; },
        }, t('admin.designCard')),
        el('span', { class: 'muted', style: 'font-size:12.5px' },
          t('admin.cardHint')))),
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.sectionsHead'))),
    secForm,
    sectionCards.length > 0
      ? el('div', { class: 'section-cards' }, sectionCards)
      : el('div', { class: 'empty' }, t('admin.noSectionsShort')),
    el('div', { style: 'margin-top:14px' },
      el('button', {
        class: 'btn secondary sm',
        onclick: e => {
          e.preventDefault();
          downloadFile(`/api/events/${event.id}/tickets.xlsx?lang=${getLang()}`, `uuids-event-${event.id}.xlsx`)
            .catch(flash);
        },
      }, t('admin.exportXlsx'))));
}
