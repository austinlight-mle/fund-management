'use strict';

/**
 * Error type for expected, user-facing failures (validation, business rules).
 * `code` is an i18n dictionary key (e.g. "error.product.duplicateName") and
 * `params` are interpolated into the translated message by the renderer.
 */
class AppError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }
}

function isUniqueViolation(err) {
  return Boolean(err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT_UNIQUE'));
}

module.exports = { AppError, isUniqueViolation };
