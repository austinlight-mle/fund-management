'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const dates = require('../src/core/dates');

// The renderer helpers are ES modules; Node loads them directly.
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'format.js')).href);

test('money parsing and formatting (KRW: no decimals)', async () => {
  const f = await load();
  f.setCurrency('KRW', 0);
  assert.equal(f.parseMoney('12,000'), 1200000);
  assert.equal(f.parseMoney(' ₩3,000,000 '), 300000000);
  assert.equal(f.parseMoney(''), null);
  assert.ok(Number.isNaN(f.parseMoney('12.5')));
  assert.ok(Number.isNaN(f.parseMoney('-100')));
  assert.ok(Number.isNaN(f.parseMoney('abc')));
  assert.equal(f.formatMoney(1200000), '12,000');
  assert.equal(f.formatMoney(1200000, { sign: true }), '+12,000');
  assert.equal(f.formatMoney(-1460000, { sign: true }), '−14,600');
  assert.equal(f.formatMoney(0, { sign: true }), '0');
  assert.equal(f.formatMoney(298540000, { symbol: true }), '₩2,985,400');
  assert.equal(f.toInputMoney(250000), '2500');
});

test('money parsing and formatting (USD: two decimals, exact cents)', async () => {
  const f = await load();
  f.setCurrency('USD', 2);
  assert.equal(f.parseMoney('12.34'), 1234);
  assert.equal(f.parseMoney('0.1'), 10);
  assert.equal(f.parseMoney('1,234.05'), 123405);
  assert.ok(Number.isNaN(f.parseMoney('1.234')));
  assert.equal(f.formatMoney(1234), '12.34');
  assert.equal(f.formatMoney(-5, { sign: true }), '−0.05');
  assert.equal(f.toInputMoney(1234), '12.34');
  // 0.1 + 0.2 style float errors cannot happen with integer minor units.
  assert.equal(f.parseMoney('0.1') + f.parseMoney('0.2'), f.parseMoney('0.3'));
  f.setCurrency('KRW', 0);
});

test('money formatting (CNY default: two decimals, ¥ symbol)', async () => {
  const f = await load();
  f.setCurrency('CNY', 2);
  assert.equal(f.parseMoney('12.5'), 1250);
  assert.equal(f.parseMoney('¥3,000,000'), 300000000);
  assert.equal(f.formatMoney(298540000, { symbol: true }), '¥2,985,400.00');
  assert.equal(f.formatMoney(-1460000, { sign: true }), '−14,600.00');
  assert.equal(f.toInputMoney(1250), '12.50');
  f.setCurrency('KRW', 0);
});

test('quantity parsing and month helpers', async () => {
  const f = await load();
  assert.equal(f.parseCount('3'), 3);
  assert.equal(f.parseCount('1,000'), 1000);
  assert.equal(f.parseCount(''), null);
  assert.ok(Number.isNaN(f.parseCount('0')));
  assert.ok(Number.isNaN(f.parseCount('1.5')));
  assert.equal(f.addMonths('2026-01', -1), '2025-12');
  assert.equal(f.addMonths('2026-12', 1), '2027-01');
  assert.equal(f.lastDayOfMonth('2028-02'), '2028-02-29');
  assert.ok(f.isValidDate('2028-02-29'));
  assert.ok(!f.isValidDate('2026-02-29'));
});

test('core date helpers', () => {
  assert.deepEqual(dates.monthRange('2026-01'), {
    month: '2026-01',
    start: '2026-01-01',
    end: '2026-02-01',
    prevMonth: '2025-12',
    prevStart: '2025-12-01',
    nextMonth: '2026-02',
  });
  assert.equal(dates.addMonths('2026-03', -15), '2024-12');
  assert.ok(dates.isValidDate('2024-02-29'));
  assert.ok(!dates.isValidDate('2023-02-29'));
  assert.ok(!dates.isValidDate('2026-13-01'));
  assert.ok(!dates.isValidDate('2026-1-01'));
  assert.ok(dates.isValidMonth('2026-12'));
  assert.ok(!dates.isValidMonth('2026-00'));
  assert.equal(dates.formatLocalDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
