'use strict';

// All dates are stored as local calendar dates in 'YYYY-MM-DD' text form and
// months as 'YYYY-MM'. Text comparison of these strings is chronological.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

const pad2 = (n) => String(n).padStart(2, '0');

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function isValidMonth(value) {
  if (typeof value !== 'string') return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12;
}

function monthOf(date) {
  return date.slice(0, 7);
}

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

function firstDayOf(month) {
  return `${month}-01`;
}

/** Boundaries used by the ledger query: [start, end) plus the previous month. */
function monthRange(month) {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  return {
    month,
    start: firstDayOf(month),
    end: firstDayOf(next),
    prevMonth: prev,
    prevStart: firstDayOf(prev),
    nextMonth: next,
  };
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowIso(date = new Date()) {
  return date.toISOString();
}

module.exports = {
  isValidDate,
  isValidMonth,
  monthOf,
  addMonths,
  firstDayOf,
  monthRange,
  formatLocalDate,
  nowIso,
  daysInMonth,
};
