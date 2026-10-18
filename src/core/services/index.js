'use strict';

const { createLedgerService } = require('./ledger');
const { createCategoryService } = require('./categories');
const { createProductService } = require('./products');
const { createFundService } = require('./funds');
const { createPurchaseService } = require('./purchases');
const { createUserService } = require('./users');
const { createSettingsService } = require('./settings');
const { createI18nService } = require('./i18n');
const { createReportService } = require('./report');
const { AuthSession } = require('./auth');

/**
 * Wires every service around one database connection.
 * `clock.now()` is injectable so tests can control "today" and lockout times.
 */
function createServices(db, { clock = { now: () => new Date() }, dictionaries, issuer } = {}) {
  const users = createUserService(db);
  const auth = new AuthSession(db, { users, clock, issuer });
  const actorId = () => auth.userId;
  const ledger = createLedgerService(db, { clock, actorId });
  const categories = createCategoryService(db);
  const products = createProductService(db, { categories });
  const funds = createFundService(db, { ledger, actorId });
  const purchases = createPurchaseService(db, { ledger, products, actorId });
  const settings = createSettingsService(db);
  const i18n = createI18nService(db, dictionaries);
  const report = createReportService(db, { ledger, clock });
  return { db, clock, users, auth, ledger, categories, products, funds, purchases, settings, i18n, report };
}

module.exports = { createServices };
