import { api } from './api.js';
import {
  getAccounts, activeAccount, activeToken,
  addAccount, switchAccount, removeActiveAccount,
} from './session.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSectionDetail } from './views/section.js';
import { renderScanner } from './views/scanner.js';
import { renderAdmin } from './views/admin.js';

export const state = {
  user: null,        // { id, username, role, events: [...] }
  eventId: null,     // currently selected event
};

export function currentEvent() {
  return state.user?.events.find(e => e.id === state.eventId) || null;
}

export function selectEvent(id) {
  state.eventId = id;
  localStorage.setItem('voreinlass_event', String(id));
  route();
}

export async function refreshUser() {
  state.user = await api.get('/api/me');
  const stored = Number(localStorage.getItem('voreinlass_event'));
  const events = state.user.events;
  state.eventId = events.some(e => e.id === stored) ? stored : (events[0]?.id ?? null);
}

// ------------------------------------------------------------------ dom

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

// ------------------------------------------------------------------ shell

const app = document.getElementById('app');
let cleanup = null; // view teardown (e.g. stop the camera)

const ROUTES = [
  { path: /^#\/dashboard$/, title: 'Dashboard', render: renderDashboard },
  { path: /^#\/sections\/(\d+)$/, title: 'Abteilung', render: renderSectionDetail },
  { path: /^#\/scanner$/, title: 'Scannen', render: renderScanner, bare: true },
  { path: /^#\/verwaltung$/, title: 'Verwaltung', render: renderAdmin, roles: ['OWNER', 'EVENT_ADMIN'] },
];

function navItems() {
  const items = [
    { hash: '#/dashboard', label: 'Dashboard', icon: '▦' },
    { hash: '#/scanner', label: 'Scannen', icon: '⛶' },
  ];
  if (['OWNER', 'EVENT_ADMIN'].includes(state.user.role)) {
    items.push({ hash: '#/verwaltung', label: 'Verwaltung', icon: '⚙' });
  }
  return items;
}

function renderShell(title, bare) {
  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' }, el('span', { class: 'logo' }, '⬢'), 'Voreinlass'),
    el('nav', { class: 'nav' },
      navItems().map(item =>
        el('a', {
          href: item.hash,
          class: location.hash.startsWith(item.hash) ? 'active' : '',
        }, el('span', {}, item.icon), item.label))),
    accountSwitcher());

  const burger = el('button', { class: 'burger', 'aria-label': 'Menü' }, '☰');
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

  const eventPicker = state.user.events.length > 1
    ? el('select', {
        onchange: e => selectEvent(Number(e.target.value)),
        style: 'width:auto',
      }, state.user.events.map(ev =>
        el('option', { value: ev.id, ...(ev.id === state.eventId ? { selected: '' } : {}) }, ev.name)))
    : null;

  const content = el('div', { class: bare ? '' : 'content' });
  app.replaceChildren(
    el('div', { class: 'shell' },
      sidebar,
      el('main', { class: 'main' },
        el('header', { class: 'topbar' }, burger, el('h1', {}, title), eventPicker),
        content)));
  return content;
}

function roleLabel(role) {
  return { OWNER: 'Owner', EVENT_ADMIN: 'Event-Admin', SCANNER: 'Scanner' }[role] || role;
}

// -------------------------------------------------------- account switcher

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
        onclick: () => { state.addingAccount = true; route(); },
      }, el('span', { class: 'avatar' }, '＋'), 'Konto hinzufügen'),
      el('button', { class: 'account-item', onclick: doLogout },
        el('span', { class: 'avatar' }, '⏻'), `Abmelden (${state.user.username})`));
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
  try { await api.post('/api/logout'); } catch { /* session may already be dead */ }
  removeActiveAccount();
  state.user = null;
  route();
}

// ------------------------------------------------------------------ router

async function route() {
  cleanup?.();
  cleanup = null;

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
        // stored session expired → drop it and fall through to the next account
        removeActiveAccount();
        continue;
      }
      return showLogin(false);
    }
  }

  const match = ROUTES.map(r => ({ r, m: location.hash.match(r.path) })).find(x => x.m);
  if (!match) {
    location.hash = '#/dashboard';
    return;
  }
  const { r, m } = match;
  if (r.roles && !r.roles.includes(state.user.role)) {
    location.hash = '#/dashboard';
    return;
  }
  const content = renderShell(r.title, r.bare);
  cleanup = await r.render(content, ...m.slice(1).map(Number)) || null;
}

function showLogin(cancelable) {
  app.replaceChildren();
  renderLogin(app, result => {
    addAccount(result);
    state.user = null;
    location.hash = '#/dashboard';
    route();
  }, cancelable && activeAccount() ? () => { state.user = null; route(); } : null);
}

window.addEventListener('hashchange', route);
route();
