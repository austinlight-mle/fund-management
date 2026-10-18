import { call } from './api.js';

let messages = {};
let lang = 'en';

export async function loadI18n() {
  const bundle = await call('i18n:bundle');
  messages = bundle.messages;
  lang = bundle.lang;
  document.documentElement.lang = lang;
}

export function getLang() {
  return lang;
}

export function locale() {
  return lang === 'ko' ? 'ko-KR' : 'en-US';
}

/**
 * Translate a dictionary key; "{name}" placeholders are replaced from params.
 * When params.count === 1 a "<key>_one" variant is used if the dictionary has one.
 */
export function t(key, params = {}) {
  const singular = params.count === 1 && messages[`${key}_one`] !== undefined;
  const text = messages[singular ? `${key}_one` : key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

export function has(key) {
  return Object.prototype.hasOwnProperty.call(messages, key);
}

/** Human readable message for an ApiError (or any thrown error). */
export function errorMessage(err) {
  if (err && err.code && has(err.code)) {
    const params = { ...(err.params || {}) };
    if (params.field && has(`field.${params.field}`)) params.field = t(`field.${params.field}`);
    if (typeof params.month === 'string' && /^\d{4}-\d{2}$/.test(params.month)) {
      const [y, m] = params.month.split('-').map(Number);
      params.month = new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long' }).format(new Date(y, m - 1, 1));
    }
    return t(err.code, params);
  }
  return t('error.unexpected', { message: (err && (err.params?.message || err.message)) || '' });
}
