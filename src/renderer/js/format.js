import { locale } from './i18n.js';

// Amounts travel as integer minor units (value x 100), matching the database.
export const SCALE = 100;

let currency = 'KRW';
let decimals = 0;

export function setCurrency(code, digits) {
  currency = code;
  decimals = digits;
}

export function currencyDecimals() {
  return decimals;
}

export function currencyCode() {
  return currency;
}

const MINUS = '−';

/** 1234500 -> "12,345" (KRW) / "12,345.00" (USD). Options: sign (+ for positive), symbol. */
export function formatMoney(minor, { sign = false, symbol = false } = {}) {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '';
  const value = Math.abs(minor) / SCALE;
  const options = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (symbol) Object.assign(options, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
  let text = new Intl.NumberFormat(locale(), options).format(value);
  if (minor < 0) text = MINUS + text;
  else if (sign && minor > 0) text = `+${text}`;
  return text;
}

/** Value for an <input>: plain digits, no grouping, so it is easy to edit. */
export function toInputMoney(minor) {
  if (minor === null || minor === undefined) return '';
  return (minor / SCALE).toFixed(decimals);
}

/**
 * Parses user input ("12,000", "₩12000", "12.5") into minor units.
 * Returns null when empty and NaN when invalid (negative or too many decimals).
 */
export function parseMoney(text) {
  const clean = String(text ?? '').replace(/[\s,₩$€¥£]/g, '');
  if (clean === '') return null;
  const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!re.test(clean)) return NaN;
  const [whole, frac = ''] = clean.split('.');
  const minor = Number(whole) * SCALE + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : NaN;
}

export function parseCount(text) {
  const clean = String(text ?? '').replace(/[\s,]/g, '');
  if (clean === '') return null;
  if (!/^\d+$/.test(clean)) return NaN;
  const n = Number(clean);
  return n >= 1 && n <= 100000 ? n : NaN;
}

export function moneyClass(minor) {
  if (minor > 0) return 'amount-plus';
  if (minor < 0) return 'amount-minus';
  return 'amount-zero';
}

// ---- dates -------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function currentMonth() {
  return todayLocal().slice(0, 7);
}

export function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}

export function formatMonth(month) {
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long' }).format(parseDate(`${month}-01`));
}

export function formatMonthShort(month) {
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short' }).format(parseDate(`${month}-01`));
}

export function formatDate(date, { weekday = true } = {}) {
  if (!date) return '';
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (weekday) opts.weekday = 'short';
  return new Intl.DateTimeFormat(locale(), opts).format(parseDate(date));
}

export function formatDayShort(date) {
  return new Intl.DateTimeFormat(locale(), { month: '2-digit', day: '2-digit', weekday: 'short' }).format(parseDate(date));
}

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = parseDate(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === value;
}

export function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(y, m, 0).getDate())}`;
}
