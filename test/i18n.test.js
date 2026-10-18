'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, throwsCode } = require('./helpers');
const { loadDictionaries } = require('../src/core/services/i18n');
const { LANGUAGES, CURRENCIES, THEMES } = require('../src/core/services/settings');

const SRC = path.join(__dirname, '..', 'src');
const dict = loadDictionaries();
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

test('English and Korean dictionaries have the same keys and placeholders', () => {
  const en = Object.keys(dict.en).sort();
  const ko = Object.keys(dict.ko).sort();
  assert.deepEqual(ko.filter((k) => !dict.en[k]), [], 'keys only in ko.json');
  assert.deepEqual(en.filter((k) => !dict.ko[k]), [], 'keys missing from ko.json');
  for (const key of en) {
    assert.ok(dict.en[key].trim(), `empty English text for ${key}`);
    assert.ok(dict.ko[key].trim(), `empty Korean text for ${key}`);
    assert.deepEqual(placeholders(dict.ko[key]), placeholders(dict.en[key]), `placeholders differ for ${key}`);
  }
});

test('every dictionary key referenced in the source exists', () => {
  const used = new Set();
  for (const file of sourceFiles(SRC)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
    for (const m of code.matchAll(/AppError\(\s*'([\w.]+)'/g)) used.add(m[1]);
    for (const m of code.matchAll(/label: '((?:nav)\.[\w.]+)'/g)) used.add(m[1]);
    // Field names passed to validators are shown via "field.<name>".
    for (const m of code.matchAll(/v\.\w+\([^)]*?,\s*'(\w+)'/g)) used.add(`field.${m[1]}`);
  }
  for (const lang of LANGUAGES) used.add(`lang.${lang}`);
  for (const code of Object.keys(CURRENCIES)) used.add(`currency.${code}`);
  for (const theme of THEMES) used.add(`theme.${theme}`);
  for (const tab of ['general', 'account', 'security', 'users', 'dictionary', 'data']) used.add(`settings.tab.${tab}`);
  for (const f of ['date', 'month', 'id']) used.add(`field.${f}`);

  const missing = [...used].filter((k) => !(k in dict.en)).sort();
  assert.deepEqual(missing, [], 'keys used in code but missing from en.json');
  assert.ok(used.size > 250, `scanned ${used.size} keys`);
});

test('dictionary overrides change the bundle and can be reset', () => {
  const s = setup();
  assert.equal(s.i18n.bundle('ko').messages['nav.funds'], dict.ko['nav.funds']);
  s.i18n.setOverride('ko', 'nav.funds', '자금 내역');
  assert.equal(s.i18n.bundle('ko').messages['nav.funds'], '자금 내역');
  assert.equal(s.i18n.bundle('en').messages['nav.funds'], 'Funds');
  const entry = s.i18n.entries().find((e) => e.key === 'nav.funds');
  assert.deepEqual(entry.ko, { default: dict.ko['nav.funds'], override: '자금 내역' });
  s.i18n.resetOverride('ko', 'nav.funds');
  assert.equal(s.i18n.bundle('ko').messages['nav.funds'], dict.ko['nav.funds']);
  throwsCode(assert, () => s.i18n.setOverride('ko', 'no.such.key', 'x'), 'error.i18n.unknownKey');
  throwsCode(assert, () => s.i18n.setOverride('fr', 'nav.funds', 'x'), 'error.i18n.unknownKey');
  throwsCode(assert, () => s.i18n.setOverride('ko', 'nav.funds', '  '), 'error.validation.required');
  assert.equal(s.i18n.t('ko', 'purchases.carriedOverFrom', { month: '2026년 9월' }), '2026년 9월 이월금');
  assert.equal(s.i18n.bundle('xx').lang, 'en');
});

test('settings: defaults are dark theme and Chinese yuan; language follows the OS locale on first run', () => {
  const s = setup();
  const defaults = s.settings.getAll();
  assert.equal(defaults.theme, 'dark');
  assert.equal(defaults.currency, 'CNY');
  assert.equal(defaults.currencyDecimals, 2);
  assert.deepEqual(defaults.currencies, ['USD', 'KRW', 'CNY']);
  assert.deepEqual(defaults.themes, ['dark', 'light']);

  s.settings.ensureDefaults({ locale: 'ko-KR' });
  assert.equal(s.settings.getAll().language, 'ko');
  s.settings.ensureDefaults({ locale: 'en-US' }); // does not overwrite
  assert.equal(s.settings.getAll().language, 'ko');
});

test('settings: validated updates for theme and currency', () => {
  const s = setup();
  assert.equal(s.settings.set('theme', 'light').theme, 'light');
  assert.equal(s.settings.set('theme', 'dark').theme, 'dark');
  assert.equal(s.settings.set('currency', 'USD').currencyDecimals, 2);
  assert.equal(s.settings.set('currency', 'KRW').currencyDecimals, 0);
  assert.equal(s.settings.set('currency', 'CNY').currencyDecimals, 2);
  throwsCode(assert, () => s.settings.set('theme', 'blue'), 'error.settings.invalid');
  throwsCode(assert, () => s.settings.set('language', 'fr'), 'error.settings.invalid');
  throwsCode(assert, () => s.settings.set('currency', 'EUR'), 'error.settings.invalid');
  throwsCode(assert, () => s.settings.set('password', 'x'), 'error.settings.invalid');
  // A currency that is no longer offered (from an older database) falls back to the default.
  s.db.prepare("UPDATE app_setting SET value = 'EUR' WHERE key = 'currency'").run();
  assert.equal(s.settings.getAll().currency, 'CNY');
});
