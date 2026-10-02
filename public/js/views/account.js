import { api } from '../api.js';
import { el } from '../app.js';
import { t } from '../i18n.js';

const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);

/** Change-password form for the signed-in user (every role). */
export async function renderAccount(content) {
  const current = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: '8' });
  const repeat = el('input', { type: 'password', autocomplete: 'new-password', required: '' });
  const message = el('div', { style: 'margin-top:12px;font-size:13.5px', role: 'status' });
  const submit = el('button', { class: 'btn', type: 'submit' }, t('account.changePassword'));
  const form = el('form', {},
    field(t('account.current'), current),
    field(t('account.new'), next),
    field(t('account.repeat'), repeat),
    el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:0' }, t('account.hint')),
    submit, message);

  function show(text, isError) {
    message.className = isError ? 'error-text' : 'muted';
    message.textContent = text;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    show('', false);
    if (next.value !== repeat.value) return show(t('account.mismatch'), true);
    submit.disabled = true;
    try {
      await api.post('/api/me/password', { current: current.value, next: next.value });
      form.reset();
      show(t('account.saved'), false);
    } catch (err) {
      show(err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  content.replaceChildren(
    el('div', { class: 'card', style: 'max-width:440px' },
      el('div', { class: 'label', style: 'margin-bottom:12px' }, t('account.changePassword')),
      form));
}
