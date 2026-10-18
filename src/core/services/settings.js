'use strict';

const { AppError } = require('../errors');

const LANGUAGES = ['en', 'ko'];
const THEMES = ['dark', 'light'];
// Display precision per currency. Amounts are always stored as value x 100.
const CURRENCIES = { USD: 2, KRW: 0, CNY: 2 };
const DEFAULTS = { language: 'en', currency: 'CNY', theme: 'dark' };
const ALLOWED = { language: LANGUAGES, theme: THEMES, currency: Object.keys(CURRENCIES) };

function createSettingsService(db) {
  const getStmt = db.prepare('SELECT value FROM app_setting WHERE key = ?').pluck();
  const setStmt = db.prepare(
    `INSERT INTO app_setting (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  );

  /** Stored value if it is still supported, otherwise the default. */
  function read(key) {
    const value = getStmt.get(key);
    return ALLOWED[key].includes(value) ? value : DEFAULTS[key];
  }

  function getAll() {
    const currency = read('currency');
    return {
      language: read('language'),
      theme: read('theme'),
      currency,
      currencyDecimals: CURRENCIES[currency],
      languages: LANGUAGES,
      themes: THEMES,
      currencies: Object.keys(CURRENCIES),
    };
  }

  function set(key, value) {
    if (!ALLOWED[key] || !ALLOWED[key].includes(value)) throw new AppError('error.settings.invalid');
    setStmt.run(key, value);
    return getAll();
  }

  /** First run: pick the UI language from the OS locale. */
  function ensureDefaults({ locale } = {}) {
    if (!getStmt.get('language')) {
      setStmt.run('language', String(locale || '').toLowerCase().startsWith('ko') ? 'ko' : DEFAULTS.language);
    }
  }

  return { getAll, set, ensureDefaults };
}

module.exports = { createSettingsService, LANGUAGES, THEMES, CURRENCIES, DEFAULTS };
