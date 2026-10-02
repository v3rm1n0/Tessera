import { api, setUnauthorizedHandler } from './api.js';
import {
  getAccounts, activeAccount, activeToken,
  addAccount, switchAccount, removeActiveAccount, dropAccount,
} from './session.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSectionDetail } from './views/section.js';
import { renderHistory } from './views/history.js';
import { renderCodes } from './views/codes.js';
import { renderLog } from './views/log.js';
import { renderAccount } from './views/account.js';
import { renderScanner } from './views/scanner.js';
import { renderAdmin } from './views/admin.js';
import { renderCardEditor } from './views/card.js';
import { initTheme } from './theme.js';
import { t, initI18n } from './i18n.js';
import { renderSettingsControls } from './settings.js';
import { icon } from './icons.js';

export const state = {
  user: null,     // { id, username, role, events: [...] }
  eventId: null,
};

export function currentEvent() {
  return state.user?.events.find(e => e.id === state.eventId) || null;
}

export function selectEvent(id) {
  state.eventId = id;
  localStorage.setItem('tessera_event', String(id));
  route();
}

export async function refreshUser() {
  state.user = await api.get('/api/me', { skipAuthHandler: true });
  const stored = Number(localStorage.getItem('tessera_event'));
  const events = state.user.events;
  state.eventId = events.some(e => e.id === stored) ? stored : ((events.find(e => !e.archived) ?? events[0])?.id ?? null);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined));
  return node;
}

const app = document.getElementById('app');
let cleanup = null; // view teardown (e.g. stop the camera)

const EVENT_ROLES = ['EVENT_ADMIN', 'SCANNER'];

const ROUTES = [
  { path: /^#\/dashboard$/, titleKey: 'title.dashboard', render: renderDashboard, roles: EVENT_ROLES },
  { path: /^#\/sections\/(\d+)$/, titleKey: 'title.section', render: renderSectionDetail, roles: EVENT_ROLES },
  { path: /^#\/scanner$/, titleKey: 'title.scan', render: renderScanner, bare: true, roles: EVENT_ROLES },
  { path: /^#\/history$/, titleKey: 'title.history', render: renderHistory, roles: EVENT_ROLES },
  { path: /^#\/codes$/, titleKey: 'title.codes', render: renderCodes, roles: ['EVENT_ADMIN'] },
  { path: /^#\/log$/, titleKey: 'title.log', render: renderLog, roles: ['EVENT_ADMIN'] },
  { path: /^#\/account$/, titleKey: 'title.account', render: renderAccount, roles: ['OWNER', 'EVENT_ADMIN', 'SCANNER'] },
  { path: /^#\/verwaltung$/, titleKey: 'title.admin', render: renderAdmin, roles: ['OWNER', 'EVENT_ADMIN'] },
  { path: /^#\/karte\/(\d+)$/, titleKey: 'title.card', render: renderCardEditor, roles: ['EVENT_ADMIN'] },
];

/** The owner administrates only; day-to-day views belong to the event roles. */
function defaultRoute() {
  return state.user.role === 'OWNER' ? '#/verwaltung' : '#/dashboard';
}

function navItems() {
  const items = [];
  if (EVENT_ROLES.includes(state.user.role)) {
    items.push(
      { hash: '#/dashboard', label: t('nav.dashboard'), icon: 'dashboard' },
      { hash: '#/scanner', label: t('nav.scan'), icon: 'scan' },
      { hash: '#/history', label: t('nav.history'), icon: 'history' });
  }
  if (state.user.role === 'EVENT_ADMIN') {
    items.push(
      { hash: '#/codes', label: t('nav.codes'), icon: 'codes' },
      { hash: '#/log', label: t('nav.log'), icon: 'log' });
  }
  if (['OWNER', 'EVENT_ADMIN'].includes(state.user.role)) {
    items.push({ hash: '#/verwaltung', label: t('nav.admin'), icon: 'settings' });
  }
  return items;
}

function renderShell(title, bare) {
  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' }, el('span', { class: 'logo' }, '⬢'), 'Tessera'),
    el('nav', { class: 'nav' },
      navItems().map(item =>
        el('a', {
          href: item.hash,
          class: location.hash.startsWith(item.hash) ? 'active' : '',
        }, icon(item.icon, 'icon nav-icon'), item.label))),
    accountSwitcher());

  const burger = el('button', { class: 'burger', 'aria-label': t('menu.label') }, '☰');
  let backdrop = null;
  burger.addEventListener('click', () => {
    sidebar.classList.add('open');
    backdrop = el('div', { class: 'backdrop' });
    backdrop.addEventListener('click', closeMenu);
    document.body.append(backdrop);
  });
  function closeMenu() {
    sidebar.classList.remove('open');
    backdrop?.remove();
  }
  sidebar.addEventListener('click', e => { if (e.target.closest('a')) closeMenu(); });

  const option = ev => el('option', { value: ev.id, ...(ev.id === state.eventId ? { selected: '' } : {}) }, ev.name);
  const liveEvents = state.user.events.filter(ev => !ev.archived);
  const oldEvents = state.user.events.filter(ev => ev.archived);
  const eventPicker = state.user.role !== 'OWNER' && state.user.events.length > 1
    ? el('select', {
        onchange: e => selectEvent(Number(e.target.value)),
        style: 'width:auto',
      }, liveEvents.map(option),
        oldEvents.length > 0 ? el('optgroup', { label: t('event.archivedGroup') }, oldEvents.map(option)) : null)
    : null;
  const archivedBadge = currentEvent()?.archived
    ? el('span', { class: 'badge warn' }, t('event.archivedBadge'))
    : null;

  const content = el('div', { class: bare ? '' : 'content' });
  app.replaceChildren(
    el('div', { class: 'shell' },
      sidebar,
      el('main', { class: 'main' },
        el('header', { class: 'topbar' }, burger, el('h1', {}, title), archivedBadge, eventPicker),
        content)));
  return content;
}

function roleLabel(role) {
  return t('role.' + role);
}

function accountSwitcher() {
  const menu = el('div', { class: 'account-menu', style: 'display:none' });

  function buildMenu() {
    const accounts = getAccounts();
    menu.replaceChildren(
      ...accounts.map(a => {
        const item = el('button', { class: 'account-item' + (a.username === state.user.username ? ' active' : '') },
          el('div', { class: 'avatar' }, a.username.slice(0, 1)),
          el('div', { class: 'who' },
            el('div', {}, a.username),
            el('div', { class: 'role' }, roleLabel(a.role))),
          a.username === state.user.username ? el('span', { class: 'check' }, '✓') : '');
        item.addEventListener('click', () => {
          if (a.username !== state.user.username) {
            switchAccount(a.username);
            state.user = null;
            route();
          }
        });
        return item;
      }),
      el('div', { class: 'account-sep' }),
      el('button', {
        class: 'account-item',
        onclick: () => { menu.style.display = 'none'; location.hash = '#/account'; },
      }, el('span', { class: 'avatar' }, icon('settings', 'icon')), t('account.changePassword')),
      el('button', {
        class: 'account-item',
        onclick: () => { state.addingAccount = true; route(); },
      }, el('span', { class: 'avatar' }, '＋'), t('account.add')),
      el('button', { class: 'account-item', onclick: doLogout },
        el('span', { class: 'avatar' }, icon('logout', 'icon')), t('account.logout', { name: state.user.username })),
      el('div', { class: 'account-sep' }),
      el('div', { style: 'padding:6px 8px' }, renderSettingsControls()));
  }

  const trigger = el('button', { class: 'sidebar-footer account-trigger' },
    el('div', { class: 'avatar' }, state.user.username.slice(0, 1)),
    el('div', { class: 'who' },
      el('div', {}, state.user.username),
      el('div', { class: 'role' }, roleLabel(state.user.role))),
    el('span', { class: 'muted' }, '⌵'));
  trigger.addEventListener('click', () => {
    const open = menu.style.display !== 'none';
    if (!open) buildMenu();
    menu.style.display = open ? 'none' : 'block';
  });

  return el('div', { class: 'account-switcher' }, menu, trigger);
}

async function doLogout() {
  try { await api.post('/api/logout', undefined, { skipAuthHandler: true }); } catch { /* session may already be dead */ }
  removeActiveAccount();
  state.user = null;
  route();
}

let pendingLogin = null; // { username, notice } for the login screen after a session ended
let expiring = false;

/** The active account's session is gone: forget it and ask for the password again, prefilled. */
function sessionExpired() {
  const name = activeAccount()?.username;
  if (!name || expiring) return;
  expiring = true;
  dropAccount(name);
  state.user = null;
  pendingLogin = { username: name, notice: t('session.expired', { name }) };
  route().finally(() => { expiring = false; });
}
setUnauthorizedHandler(sessionExpired);

async function route() {
  cleanup?.();
  cleanup = null;

  if (pendingLogin) {
    const prefill = pendingLogin;
    pendingLogin = null;
    return showLogin(true, prefill);
  }
  if (state.addingAccount) {
    state.addingAccount = false;
    return showLogin(true);
  }

  while (!state.user) {
    if (!activeToken()) return showLogin(false);
    try {
      await refreshUser();
    } catch (err) {
      if (err.status === 401) {
        // the stored session expired: ask for this account's password instead of silently
        // showing a different account
        const name = activeAccount().username;
        dropAccount(name);
        return showLogin(true, { username: name, notice: t('session.expired', { name }) });
      }
      return showLogin(false);
    }
  }

  const match = ROUTES.map(r => ({ r, m: location.hash.match(r.path) })).find(x => x.m);
  if (!match) {
    location.hash = defaultRoute();
    return;
  }
  const { r, m } = match;
  if (r.roles && !r.roles.includes(state.user.role)) {
    location.hash = defaultRoute();
    return;
  }
  const content = renderShell(t(r.titleKey), r.bare);
  cleanup = await r.render(content, ...m.slice(1).map(Number)) || null;
}

function showLogin(cancelable, prefill = {}) {
  app.replaceChildren();
  renderLogin(app, result => {
    addAccount(result);
    state.user = null;
    location.hash = result.role === 'OWNER' ? '#/verwaltung' : '#/dashboard';
    route();
  }, cancelable && activeAccount() ? () => { state.user = null; route(); } : null, prefill);
}

window.addEventListener('hashchange', route);
window.addEventListener('tessera:relang', route);
initTheme();
initI18n();
route();
