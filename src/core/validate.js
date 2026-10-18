'use strict';

const { AppError } = require('./errors');
const { isValidDate, isValidMonth } = require('./dates');

// Money is stored as INTEGER minor units with a fixed scale of 100
// (e.g. 12,000 KRW -> 1200000, 12.34 USD -> 1234). Integer math keeps every
// sum exact; the display precision comes from the selected currency.
const MONEY_SCALE = 100;
const MAX_MONEY = 1e14; // 1 trillion major units – far below 2^53

function text(value, field, { max = 200, required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new AppError('error.validation.text', { field });
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new AppError('error.validation.required', { field });
  if (trimmed.length > max) throw new AppError('error.validation.tooLong', { field, max });
  return trimmed;
}

function optionalText(value, field, { max = 1000 } = {}) {
  const v = text(value, field, { max, required: false });
  return v.length ? v : null;
}

function integer(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError('error.validation.integer', { field });
  }
  if (value < min || value > max) throw new AppError('error.validation.range', { field, min, max });
  return value;
}

function money(value, field, { min = 0, max = MAX_MONEY } = {}) {
  return integer(value, field, { min, max });
}

function id(value, field = 'id') {
  return integer(value, field, { min: 1 });
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return id(value, field);
}

function date(value, field = 'date') {
  if (!isValidDate(value)) throw new AppError('error.validation.date', { field });
  return value;
}

function month(value, field = 'month') {
  if (!isValidMonth(value)) throw new AppError('error.validation.month', { field });
  return value;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

module.exports = { MONEY_SCALE, MAX_MONEY, text, optionalText, integer, money, id, optionalId, date, month, bool };
