import { t } from './i18n.js';

/** Minimal element builder: h('button', { class: 'btn', onclick }, 'Save'). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (['checked', 'disabled', 'selected', 'readOnly', 'required', 'autofocus'].includes(key)) el[key] = Boolean(value);
    else if (key === 'html') el.innerHTML = value; // only used with static, trusted markup (icons)
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---- toasts ------------------------------------------------------------

const MAX_TOASTS = 4;

export function toast(message, type = 'info', timeout = 3500) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  while (host.children.length >= MAX_TOASTS) host.firstChild.remove();
  host.append(el);
  setTimeout(() => {
    el.classList.add('toast-hide');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// ---- dialogs -----------------------------------------------------------

/**
 * Opens a modal <dialog>. `actions` are { label, kind, onClick } where onClick
 * may return false (or a promise resolving to false) to keep the dialog open.
 */
export function openDialog({ title, body, actions = [], wide = false, onClose }) {
  const dialog = h('dialog', { class: `modal${wide ? ' modal-wide' : ''}` });
  const footer = h('div', { class: 'modal-actions' });
  const close = (result) => {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    if (onClose) onClose(result);
  };
  for (const action of actions) {
    const btn = h(
      'button',
      {
        type: action.submit ? 'submit' : 'button',
        class: `btn ${action.kind ? `btn-${action.kind}` : ''}`,
        dataset: { action: action.id || '' },
        onclick: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          try {
            const keep = action.onClick ? await action.onClick() : undefined;
            if (keep !== false) close(action.id);
          } finally {
            btn.disabled = false;
          }
        },
      },
      action.label
    );
    footer.append(btn);
  }
  const form = h(
    'form',
    {
      method: 'dialog',
      onsubmit: (e) => {
        e.preventDefault();
        const submit = footer.querySelector('[type=submit]');
        if (submit) submit.click();
      },
    },
    h('h2', { class: 'modal-title' }, title),
    h('div', { class: 'modal-body' }, body),
    footer
  );
  dialog.append(form);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close('cancel');
  });
  document.body.append(dialog);
  dialog.showModal();
  const focusTarget = dialog.querySelector('[autofocus], input, select, textarea') || footer.querySelector('.btn-primary');
  if (focusTarget) focusTarget.focus();
  return { dialog, close };
}

export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: h('p', { class: 'confirm-message' }, message),
      actions: [
        { id: 'cancel', label: t('common.cancel') },
        {
          id: 'confirm',
          label: confirmLabel || t('common.confirm'),
          kind: danger ? 'danger' : 'primary',
          submit: true,
          onClick: () => {
            result = true;
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Labeled form field wrapper. */
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function formError() {
  return h('div', { class: 'form-error', role: 'alert', hidden: true });
}

export function showFormError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}
