import { api } from '../api.js';
import { el } from '../app.js';

export function renderLogin(root, onSuccess, onCancel = null) {
  const error = el('div', { class: 'error-text', style: 'display:none' });
  const username = el('input', { type: 'text', autocomplete: 'username', required: '' });
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
  const submit = el('button', { class: 'btn', type: 'submit', style: 'width:100%' }, 'Anmelden');

  const cancel = onCancel
    ? el('button', {
        class: 'btn secondary', type: 'button',
        style: 'width:100%;margin-top:8px', onclick: onCancel,
      }, 'Abbrechen')
    : null;

  const form = el('form', {},
    el('label', { class: 'field' }, el('span', {}, 'Benutzername'), username),
    el('label', { class: 'field' }, el('span', {}, 'Passwort'), password),
    error,
    submit,
    cancel);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    submit.disabled = true;
    error.style.display = 'none';
    try {
      const result = await api.post('/api/login', { username: username.value, password: password.value });
      onSuccess(result);
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      submit.disabled = false;
    }
  });

  root.replaceChildren(
    el('div', { class: 'login-wrap' },
      el('div', { class: 'login-card' },
        el('h1', {}, '⬢ Voreinlass'),
        form)));
  username.focus();
}
