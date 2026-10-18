'use strict';

const QRCode = require('qrcode');
const { AppError } = require('../core/errors');

/**
 * Registers every IPC channel. Handlers return { ok, data } or { ok: false, error }
 * so the renderer receives structured, translatable errors.
 * Channels in PUBLIC work before login; everything else requires a fully
 * authenticated session (password accepted, 2FA passed, default password changed).
 */
function registerIpc(ipcMain, { services, actions, isTrustedSender }) {
  const { auth, settings, i18n, users, categories, products, funds, purchases, ledger } = services;

  const PUBLIC = {
    'app:info': () => actions.appInfo(),
    'i18n:bundle': () => i18n.bundle(settings.getAll().language),
    'settings:get': () => settings.getAll(),
    'settings:setLanguage': ({ language }) => {
      const result = settings.set('language', language);
      actions.languageChanged();
      return result;
    },
    'settings:setTheme': ({ theme }) => {
      const result = settings.set('theme', theme);
      actions.themeChanged(result.theme);
      return result;
    },
    'auth:status': () => ({ ...auth.status(), defaultCredentials: defaultCredentialsActive() }),
    'auth:login': (p) => auth.login(p),
    'auth:verifySecondFactor': (p) => auth.verifySecondFactor(p),
    'auth:changeCredentials': (p) => auth.changeCredentials(p), // checks the password-accepted stage itself
    'auth:logout': () => auth.logout(),
  };

  const PROTECTED = {
    'settings:set': ({ key, value }) => {
      const result = settings.set(key, value);
      if (key === 'language') actions.languageChanged();
      if (key === 'theme') actions.themeChanged(result.theme);
      return result;
    },

    'auth:totpBegin': async () => {
      const setup = auth.beginTotpSetup();
      setup.qr = await QRCode.toDataURL(setup.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      return setup;
    },
    'auth:totpConfirm': (p) => auth.confirmTotpSetup(p),
    'auth:totpDisable': (p) => auth.disableTotp(p),
    'auth:recoveryRegenerate': (p) => auth.regenerateRecoveryCodes(p),
    'auth:recoveryLeft': () => auth.recoveryCodesLeft(),

    'users:list': () => users.list(),
    'users:create': (p) => users.create(p),
    'users:remove': ({ id }) => users.remove(id, auth.userId),
    'users:resetPassword': ({ id, password }) => users.resetPassword(id, password),

    'categories:list': () => categories.list(),
    'categories:create': (p) => categories.create(p),
    'categories:update': ({ id, ...p }) => categories.update(id, p),
    'categories:remove': ({ id }) => categories.remove(id),

    'products:list': (p) => products.list(p),
    'products:searchNames': ({ term, limit }) => products.searchNames(term, { limit }),
    'products:variants': ({ name }) => products.variants(name),
    'products:create': (p) => products.create(p),
    'products:update': ({ id, ...p }) => products.update(id, p),
    'products:remove': ({ id }) => products.remove(id),

    'funds:list': (p) => funds.list(p),
    'funds:create': (p) => funds.create(p),
    'funds:update': ({ id, ...p }) => funds.update(id, p),
    'funds:remove': ({ id }) => funds.remove(id),

    'purchases:get': ({ id }) => purchases.get(id),
    'purchases:create': (p) => purchases.create(p),
    'purchases:update': ({ id, ...p }) => purchases.update(id, p),
    'purchases:remove': ({ id }) => purchases.remove(id),
    'purchases:saveItems': ({ id, items }) => purchases.saveItems(id, items),

    'report:month': ({ month }) => services.report.getMonthReport(month),
    'report:exportExcel': ({ month }) => actions.exportReport(month),
    'report:openExport': () => actions.openLastExport(),

    'ledger:month': ({ month }) => ledger.getMonth(month),
    'ledger:confirm': ({ month }) => ledger.confirmMonth(month),
    'ledger:reopen': ({ month }) => ledger.reopenMonth(month),

    'i18n:entries': () => i18n.entries(),
    'i18n:setOverride': ({ lang, key, value }) => i18n.setOverride(lang, key, value),
    'i18n:resetOverride': ({ lang, key }) => i18n.resetOverride(lang, key),

    'data:backup': () => actions.backupDatabase(),
    'data:openFolder': () => actions.openDataFolder(),
  };

  function defaultCredentialsActive() {
    const admin = users.findByUsername('admin');
    return Boolean(admin && admin.must_change_password && admin.password_changed_at === null);
  }

  const wrap = (channel, fn, requiresAuth) => async (event, payload) => {
    try {
      if (!isTrustedSender(event)) throw new AppError('error.auth.required');
      if (requiresAuth) auth.requireUser();
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, error: { code: err.code, params: err.params } };
      console.error(`[ipc] ${channel} failed:`, err);
      return { ok: false, error: { code: 'error.unexpected', params: { message: String(err && err.message) } } };
    }
  };

  for (const [channel, fn] of Object.entries(PUBLIC)) ipcMain.handle(channel, wrap(channel, fn, false));
  for (const [channel, fn] of Object.entries(PROTECTED)) ipcMain.handle(channel, wrap(channel, fn, true));

  return { channels: [...Object.keys(PUBLIC), ...Object.keys(PROTECTED)] };
}

module.exports = { registerIpc };
