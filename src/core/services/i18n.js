'use strict';

const fs = require('fs');
const path = require('path');
const { AppError } = require('../errors');
const { LANGUAGES } = require('./settings');

const DICTIONARY_DIR = path.join(__dirname, '..', '..', 'i18n');

/** Loads src/i18n/<lang>.json – flat "section.key": "text" dictionaries. */
function loadDictionaries(dir = DICTIONARY_DIR) {
  const out = {};
  for (const lang of LANGUAGES) {
    out[lang] = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
  }
  return out;
}

function interpolate(text, params = {}) {
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

/**
 * Built-in dictionaries plus user edits from the translation_override table.
 * Lookup order: override(lang) -> dictionary(lang) -> override(en) -> dictionary(en) -> key.
 */
function createI18nService(db, dictionaries = loadDictionaries()) {
  function overrides(lang) {
    const rows = db.prepare('SELECT key, value FROM translation_override WHERE lang = ?').all(lang);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  function bundle(lang) {
    const target = LANGUAGES.includes(lang) ? lang : 'en';
    const messages = { ...dictionaries.en, ...overrides('en') };
    if (target !== 'en') Object.assign(messages, dictionaries[target], overrides(target));
    return { lang: target, messages };
  }

  function t(lang, key, params) {
    const { messages } = bundle(lang);
    return interpolate(messages[key] ?? key, params);
  }

  /** Every dictionary key with default and current text per language, for the dictionary editor. */
  function entries() {
    const ov = Object.fromEntries(LANGUAGES.map((l) => [l, overrides(l)]));
    return Object.keys(dictionaries.en)
      .sort()
      .map((key) => {
        const row = { key };
        for (const lang of LANGUAGES) {
          row[lang] = {
            default: dictionaries[lang][key] ?? '',
            override: ov[lang][key] ?? null,
          };
        }
        return row;
      });
  }

  function assertKey(lang, key) {
    if (!LANGUAGES.includes(lang) || !(key in dictionaries.en)) throw new AppError('error.i18n.unknownKey');
  }

  function setOverride(lang, key, value) {
    assertKey(lang, key);
    if (typeof value !== 'string' || value.trim() === '' || value.length > 1000) throw new AppError('error.validation.required', { field: 'text' });
    db.prepare(
      `INSERT INTO translation_override (lang, key, value) VALUES (?, ?, ?)
       ON CONFLICT (lang, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(lang, key, value);
    return { lang, key, value };
  }

  function resetOverride(lang, key) {
    assertKey(lang, key);
    db.prepare('DELETE FROM translation_override WHERE lang = ? AND key = ?').run(lang, key);
    return { lang, key };
  }

  return { bundle, t, entries, setOverride, resetOverride, languages: LANGUAGES };
}

module.exports = { createI18nService, loadDictionaries, interpolate, DICTIONARY_DIR };
