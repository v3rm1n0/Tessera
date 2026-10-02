import { el } from './app.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { generatePassword } from './password.js';

/**
 * A name with a pencil button: clicking it swaps the name for a text field (Enter or Save stores,
 * Escape or Cancel leaves it). `onSave(newName)` returns a promise; when it rejects the message is
 * shown and the field stays open for another try.
 */
export function editableName({ tag = 'div', attrs = {}, name, onSave, label = t('common.rename'), wrapStyle = '' }) {
  const text = el(tag, attrs, name);
  const pencil = el('button', { class: 'btn-icon', type: 'button', title: label, 'aria-label': label }, icon('edit'));
  const wrap = el('span', { class: 'editable', style: wrapStyle }, text, pencil);
  let current = name;

  pencil.addEventListener('click', () => {
    const input = el('input', { type: 'text', value: current, maxlength: '100', 'aria-label': label });
    const save = el('button', { class: 'btn sm', type: 'submit' }, t('common.save'));
    const cancel = el('button', { class: 'btn secondary sm', type: 'button' }, t('common.cancel'));
    const form = el('form', { class: 'inline-form editable-form' }, input, save, cancel);
    const close = () => wrap.replaceChildren(text, pencil);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value || value === current) return close();
      save.disabled = true;
      try {
        await onSave(value);
        current = value;
        text.textContent = value;
        close();
      } catch (err) {
        alert(err.message || String(err));
        save.disabled = false;
        input.focus();
      }
    });
    cancel.addEventListener('click', close);
    input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    wrap.replaceChildren(form);
    input.focus();
    input.select();
  });
  return wrap;
}

/** A password input plus a button that fills it with a generated password and shows it, so it can be handed over. */
export function passwordInput({ placeholder, label = t('admin.generatePassword') } = {}) {
  const input = el('input', { type: 'password', placeholder, autocomplete: 'new-password' });
  const generate = el('button', { class: 'btn secondary sm', type: 'button', title: label }, t('admin.generate'));
  generate.addEventListener('click', () => {
    input.type = 'text';
    input.value = generatePassword();
    input.focus();
    input.select();
  });
  return { input, generate };
}
