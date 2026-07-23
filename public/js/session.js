/** Account store for the switcher: several accounts can be logged in at once, each with its own session token. */
const KEY = 'tessera_accounts';
const ACTIVE = 'tessera_active';

export function getAccounts() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
  catch { return []; }
}

function save(accounts) {
  localStorage.setItem(KEY, JSON.stringify(accounts));
}

export function activeAccount() {
  const name = localStorage.getItem(ACTIVE);
  return getAccounts().find(a => a.username === name) || null;
}

export function activeToken() {
  return activeAccount()?.token || null;
}

export function addAccount({ username, role, token }) {
  const accounts = getAccounts().filter(a => a.username !== username);
  accounts.push({ username, role, token });
  save(accounts);
  localStorage.setItem(ACTIVE, username);
}

export function switchAccount(username) {
  if (getAccounts().some(a => a.username === username)) {
    localStorage.setItem(ACTIVE, username);
  }
}

/** Removes the active account; returns the next remaining account (or null). */
export function removeActiveAccount() {
  const current = activeAccount();
  const rest = getAccounts().filter(a => a.username !== current?.username);
  save(rest);
  if (rest.length > 0) {
    localStorage.setItem(ACTIVE, rest[0].username);
    return rest[0];
  }
  localStorage.removeItem(ACTIVE);
  return null;
}
