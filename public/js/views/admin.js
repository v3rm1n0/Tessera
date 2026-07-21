import { api } from '../api.js';
import { activeToken } from '../session.js';
import { el, state, currentEvent, refreshUser } from '../app.js';
import { t } from '../i18n.js';

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

/** Download links cannot send an Authorization header → token as query. */
function tokenized(url) {
  return `${url}?token=${encodeURIComponent(activeToken() || '')}`;
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

  const eventCards = events.map(ev => {
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
    const nPass = el('input', { type: 'password', placeholder: t('admin.passwordPh'), autocomplete: 'new-password' });
    const nRole = el('select', { style: 'width:auto' },
      el('option', { value: 'SCANNER' }, t('role.SCANNER')),
      el('option', { value: 'EVENT_ADMIN' }, t('role.EVENT_ADMIN')));
    const createForm = el('form', { class: 'inline-form', style: 'flex-wrap:wrap' },
      nName, nPass, nRole,
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

    return el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px' },
        el('div', { class: 'title', style: 'flex:1;font-weight:600' }, ev.name),
        el('span', { class: 'muted', style: 'font-size:12.5px' }, t('admin.reset', { time: ev.reset_time })),
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
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px' },
        memberChips.length > 0 ? memberChips
          : el('span', { class: 'muted', style: 'font-size:13px' }, t('admin.noAccounts'))),
      createForm,
      unassigned.length > 0 ? el('div', { style: 'margin-top:8px' }, addExisting) : null);
  });

  const accountRows = accounts.map(u =>
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, u.username),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `${u.role === 'EVENT_ADMIN' ? t('role.EVENT_ADMIN') : t('role.SCANNER')} · ${
            u.event_ids.length === 0 ? t('admin.noEventsAssigned')
              : u.event_ids.map(id => events.find(e => e.id === id)?.name || id).join(', ')}`)),
      el('button', {
        class: 'btn danger sm',
        onclick: async () => {
          if (!confirm(t('admin.confirmDeleteAccount', { user: u.username }))) return;
          try { await api.del(`/api/admin/users/${u.id}`); reload(); } catch (err) { flash(err); }
        },
      }, t('common.delete'))));

  return el('div', {},
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.eventsHead'))),
    evForm,
    el('div', { style: 'margin-top:12px' },
      eventCards.length > 0 ? eventCards
        : el('div', { class: 'empty' }, t('admin.noEvents'))),
    el('div', { class: 'section-head' }, el('h2', {}, t('admin.allAccounts'))),
    accountRows.length > 0
      ? el('div', { class: 'list' }, accountRows)
      : el('div', { class: 'empty' }, t('admin.noAccountsAtAll')));
}

async function eventBlock(reload) {
  const event = currentEvent();
  if (!event) {
    return el('div', { class: 'empty' }, t('admin.noEventSelected'));
  }
  const dash = await api.get(`/api/events/${event.id}/dashboard`);

  const resetInput = el('input', { type: 'time', value: dash.event.reset_time, style: 'width:auto' });
  const resetForm = el('form', { class: 'inline-form' },
    resetInput,
    el('button', { class: 'btn secondary', type: 'submit' }, t('admin.saveResetTime')));
  resetForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.patch(`/api/events/${event.id}`, { reset_time: resetInput.value });
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
          el('div', { class: 'title', style: 'font-size:14px' }, sub.name),
          el('div', { class: 'muted', style: 'font-size:12px' }, t('admin.subCodes', { n: sub.ticket_count }))),
        uuidGen(`/api/sections/${s.id}/tickets`, { subsection_id: sub.id }),
        el('button', {
          class: 'btn danger sm', title: t('admin.deleteSub'),
          onclick: async () => {
            if (!confirm(t('admin.confirmDeleteSub', { name: sub.name }))) return;
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
          el('div', { class: 'title' }, s.name),
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
      resetForm),
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
      el('a', { class: 'btn secondary sm', href: tokenized(`/api/events/${event.id}/tickets.xlsx`) },
        t('admin.exportXlsx'))));
}
