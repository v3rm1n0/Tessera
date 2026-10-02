import { api } from '../api.js';
import { el } from '../app.js';
import { renderSettingsControls } from '../settings.js';
import { t } from '../i18n.js';

/** `prefill`: { username, notice } when the screen is shown because a session ended. */
export function renderLogin(root, onSuccess, onCancel = null, { username: prefilled = '', notice = '' } = {}) {
  const error = el('div', { class: 'error-text', style: 'display:none' });
  const username = el('input', { type: 'text', autocomplete: 'username', required: '', value: prefilled });
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
  const submit = el('button', { class: 'btn', type: 'submit', style: 'width:100%' }, t('login.submit'));

  const cancel = onCancel
    ? el('button', {
        class: 'btn secondary', type: 'button',
        style: 'width:100%;margin-top:8px', onclick: onCancel,
      }, t('common.cancel'))
    : null;

  const form = el('form', {},
    notice ? el('div', { class: 'notice', role: 'status' }, notice) : null,
    el('label', { class: 'field' }, el('span', {}, t('login.username')), username),
    el('label', { class: 'field' }, el('span', {}, t('login.password')), password),
    error,
    submit,
    cancel);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    submit.disabled = true;
    error.style.display = 'none';
    try {
      const result = await api.post('/api/login', { username: username.value, password: password.value }, { skipAuthHandler: true });
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
        el('h1', {}, '⬢ Tessera'),
        form,
        el('div', { style: 'margin-top:18px' }, renderSettingsControls()))));
  (prefilled ? password : username).focus();
}
