import { el } from './app.js';
import { getThemePref, setThemePref } from './theme.js';
import { t, getLang, setLang } from './i18n.js';
import { icon } from './icons.js';

function segment(current, options, onPick) {
  const btns = options.map(o => {
    const b = el('button', {
      type: 'button',
      class: 'seg-btn' + (o.icon ? ' seg-icon' : '') + (o.value === current ? ' active' : ''),
      title: o.label, 'aria-label': o.label,
    }, o.icon ? icon(o.icon) : o.label);
    b.addEventListener('click', () => {
      if (o.value === current) return;
      onPick(o.value);
    });
    return b;
  });
  return el('div', { class: 'seg' }, btns);
}

export function renderSettingsControls() {
  const themeRow = el('div', { class: 'settings-row' },
    el('span', { class: 'settings-label' }, t('settings.theme')),
    segment(getThemePref(), [
      { value: 'system', label: t('settings.system'), icon: 'desktop' },
      { value: 'light', label: t('settings.light'), icon: 'light-mode' },
      { value: 'dark', label: t('settings.dark'), icon: 'dark-mode' },
    ], v => { setThemePref(v); rerender(wrap); }));

  const langRow = el('div', { class: 'settings-row' },
    el('span', { class: 'settings-label' }, t('settings.language')),
    segment(getLang(), [
      { value: 'de', label: 'DE' },
      { value: 'en', label: 'EN' },
    ], v => setLang(v)));  // setLang re-renders the whole view

  const wrap = el('div', { class: 'settings-controls' }, themeRow, langRow);
  return wrap;
}

// Theme change needs no full re-render; refresh just the control's active states.
function rerender(wrap) {
  const fresh = renderSettingsControls();
  wrap.replaceWith(fresh);
}
