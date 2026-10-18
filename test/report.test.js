'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { setup, loginAdmin } = require('./helpers');
const { seed, expectedMonth, sum, MONTHS } = require('./fixtures');
const { daysInMonth } = require('../src/core/dates');
const { buildReportWorkbook } = require('../src/core/report-excel');

const MONTH = '2026-04';
const key = (name, standard) => `${name.toLowerCase()}|${(standard || '').toLowerCase()}`;

/** Seeds Jan–Jun, confirms Jan–Mar so April has a carry-over, returns the inserted data. */
function seeded() {
  const s = setup({ now: '2026-10-18T12:00:00' });
  loginAdmin(s);
  const { data } = seed(s);
  ['2026-01', '2026-02', '2026-03'].forEach((m) => s.ledger.confirmMonth(m));
  // Carry-over into April, computed independently.
  let carry = null;
  for (const m of ['2026-01', '2026-02', '2026-03']) carry = expectedMonth(data, m, carry).balance;
  return { s, data, carry };
}

/** Category path and top-level name of every product, read from the products list. */
function productCategories(s) {
  const map = new Map();
  for (const p of s.products.list()) {
    const path = p.category_path || null;
    map.set(key(p.name, p.standard), { path, root: path ? path.split(' > ')[0] : null });
  }
  return map;
}

test('report numbers match an independent calculation: summary, days, categories, products, journal', () => {
  const { s, data, carry } = seeded();
  const report = s.report.getMonthReport(MONTH);
  const expected = expectedMonth(data, MONTH, carry);
  const purchases = data.purchases.filter((p) => p.date.startsWith(MONTH));
  const funds = data.funds.filter((f) => f.date.startsWith(MONTH));
  const lines = purchases.flatMap((p) => p.items.map((it) => ({ ...it, date: p.date, purchaseId: p.id })));
  assert.ok(lines.length >= 20, 'enough item lines in the month');

  // Summary.
  const sm = report.summary;
  assert.equal(sm.carryOver, carry);
  assert.equal(sm.fundIn, expected.fundIn);
  assert.equal(sm.spent, expected.spent);
  assert.equal(sm.balance, expected.balance);
  assert.equal(sm.purchaseCount, purchases.length);
  assert.equal(sm.lineCount, lines.length);
  assert.equal(sm.totalQty, sum(lines, (l) => l.count));
  assert.equal(sm.productCount, new Set(lines.map((l) => key(l.product_name, l.standard))).size);
  assert.equal(sm.daysCounted, 30); // a past month counts all of its days
  assert.equal(sm.avgDailySpend, Math.round(expected.spent / 30));
  const prevSpent = expectedMonth(data, '2026-03').spent;
  assert.equal(sm.prevSpent, prevSpent);
  assert.equal(sm.spentChange, (expected.spent - prevSpent) / prevSpent);
  const biggest = [...purchases].sort((a, b) => b.cost - a.cost || a.id - b.id)[0];
  assert.equal(sm.biggestPurchase.cost, biggest.cost);

  // Days: every day of the month, spending/funds per day and the end-of-day balance.
  assert.equal(report.days.length, daysInMonth(2026, 4));
  let running = 0;
  for (const day of report.days) {
    const dp = purchases.filter((p) => p.date === day.date);
    const df = funds.filter((f) => f.date === day.date);
    const carryToday = day.day === 1 ? carry : 0;
    assert.equal(day.spent, sum(dp, (p) => p.cost), `${day.date} spent`);
    assert.equal(day.purchaseCount, dp.length, `${day.date} purchases`);
    assert.equal(day.fundIn, sum(df, (f) => f.amount), `${day.date} funds in`);
    assert.equal(day.carryOver, carryToday, `${day.date} carried over`);
    running += carryToday + day.fundIn - day.spent;
    assert.equal(day.balance, running, `${day.date} money left`);
  }
  assert.equal(report.days[report.days.length - 1].balance, expected.balance);
  assert.equal(sum(report.days, (d) => d.spent), expected.spent);

  // Categories (top level, then subcategories) sum to the month's spending.
  const cats = productCategories(s);
  const byRoot = new Map();
  const byPath = new Map();
  for (const l of lines) {
    const c = cats.get(key(l.product_name, l.standard));
    byRoot.set(c.root, (byRoot.get(c.root) || 0) + l.price * l.count);
    byPath.set(c.path, (byPath.get(c.path) || 0) + l.price * l.count);
  }
  assert.equal(report.categories.length, byRoot.size);
  for (const cat of report.categories) {
    assert.equal(cat.spent, byRoot.get(cat.name), `category ${cat.name}`);
    assert.ok(Math.abs(cat.share - cat.spent / expected.spent) < 1e-12);
    if (cat.children.length) assert.equal(sum(cat.children, (c) => c.spent), cat.spent);
    for (const child of cat.children) {
      const path = child.name ? `${cat.name} > ${child.name}` : cat.name;
      assert.equal(child.spent, byPath.get(path), `subcategory ${path}`);
    }
  }
  assert.equal(sum(report.categories, (c) => c.spent), expected.spent);
  for (let i = 1; i < report.categories.length; i++) assert.ok(report.categories[i - 1].spent >= report.categories[i].spent);

  // Products: one row per name + standard.
  const byProduct = new Map();
  for (const l of lines) {
    const k = key(l.product_name, l.standard);
    const e = byProduct.get(k) || { qty: 0, total: 0, purchases: new Set(), min: Infinity, max: -Infinity, first: '9999', last: '' };
    e.qty += l.count;
    e.total += l.price * l.count;
    e.purchases.add(l.purchaseId);
    e.min = Math.min(e.min, l.price);
    e.max = Math.max(e.max, l.price);
    if (l.date < e.first) e.first = l.date;
    if (l.date > e.last) e.last = l.date;
    byProduct.set(k, e);
  }
  assert.equal(report.products.length, byProduct.size);
  for (const p of report.products) {
    const e = byProduct.get(key(p.name, p.standard));
    const label = `${p.name} ${p.standard}`;
    assert.equal(p.qty, e.qty, `${label} qty`);
    assert.equal(p.total, e.total, `${label} total`);
    assert.equal(p.purchaseCount, e.purchases.size, `${label} purchases`);
    assert.equal(p.minPrice, e.min, `${label} min`);
    assert.equal(p.maxPrice, e.max, `${label} max`);
    assert.equal(p.avgPrice, Math.round(e.total / e.qty), `${label} avg`);
    assert.equal(p.firstDate, e.first);
    assert.equal(p.lastDate, e.last);
  }
  assert.equal(sum(report.products, (p) => p.total), expected.spent);
  assert.ok(Math.abs(sum(report.products, (p) => p.share) - 1) < 1e-9);
  // Same name, different standard: separate rows.
  const milk = report.products.filter((p) => p.name === 'Milk').map((p) => p.standard).sort();
  assert.deepEqual(milk, [...new Set(lines.filter((l) => l.product_name === 'Milk').map((l) => l.standard))].sort());

  // Journal: days with records, purchases with their items in entry order.
  const recordDays = new Set([...purchases.map((p) => p.date), ...funds.map((f) => f.date), `${MONTH}-01`]);
  assert.equal(report.journal.length, recordDays.size);
  const journalPurchases = report.journal.flatMap((d) => d.entries.filter((e) => e.kind === 'purchase'));
  assert.equal(journalPurchases.length, purchases.length);
  for (const jp of journalPurchases) {
    const p = purchases.find((x) => x.id === jp.id);
    assert.equal(jp.cost, p.cost);
    assert.equal(jp.items.length, p.items.length);
    assert.equal(sum(jp.items, (it) => it.total), p.cost);
    assert.deepEqual(jp.items.map((it) => it.count), p.items.map((it) => it.count));
  }
});

test('report for the current month counts days so far; empty months are well-formed', () => {
  const s = setup({ now: '2026-10-18T12:00:00' });
  loginAdmin(s);
  s.funds.create({ amount: 100000, date: '2026-10-02' });
  const p = s.purchases.create({ date: '2026-10-05', summary: 'Mart' });
  s.purchases.saveItems(p.id, [{ product_name: 'Milk', standard: '1L', price: 1800, count: 2 }]);
  const report = s.report.getMonthReport('2026-10');
  assert.equal(report.summary.daysCounted, 18);
  assert.equal(report.summary.avgDailySpend, Math.round(3600 / 18));
  assert.equal(report.days[17].balance, 100000 - 3600); // today
  assert.equal(report.days[18].balance, null); // days still ahead have no balance yet
  assert.equal(report.days[0].balance, 0);
  assert.equal(report.summary.spentChange, null); // nothing spent in September

  const empty = s.report.getMonthReport('2027-02');
  assert.equal(empty.days.length, 28);
  assert.deepEqual(empty.products, []);
  assert.deepEqual(empty.categories, []);
  assert.deepEqual(empty.journal, []);
  assert.equal(empty.summary.daysCounted, 0);
  assert.equal(empty.summary.biggestPurchase, null);
  assert.ok(empty.days.every((d) => d.balance === null));
});

async function workbookFor(report, { lang = 'en', currency = 'CNY', decimals = 2, s }) {
  const wb = buildReportWorkbook(report, {
    t: (k, p) => s.i18n.t(lang, k, p),
    lang,
    locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    currency,
    decimals,
    generatedAt: new Date('2026-10-18T12:00:00'),
  });
  const buffer = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer);
  return back;
}

const resultOf = (cell) => (cell.value && typeof cell.value === 'object' && 'result' in cell.value ? cell.value.result : cell.value);
const cents = (v) => Math.round(v * 100);

test('Excel export: four styled sheets whose numbers match the report', async () => {
  const { s } = seeded();
  const report = s.report.getMonthReport(MONTH);
  const wb = await workbookFor(report, { s });
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Daily', 'Products', 'Details']);

  // Summary: title, KPI values, category table totals.
  const summary = wb.getWorksheet('Summary');
  assert.match(summary.getCell('A1').value, /^Monthly Report · April 2026$/);
  assert.equal(summary.getCell('A1').font.size, 16);
  assert.equal(summary.getRow(1).height, 30);
  const kpi = (label) => {
    for (let r = 5; r <= 20; r++) if (summary.getCell(r, 1).value === label) return summary.getCell(r, 3);
    throw new Error(`KPI ${label} not found`);
  };
  assert.equal(cents(kpi('Spent').value), report.summary.spent);
  assert.equal(cents(kpi('Money left').value), report.summary.balance);
  assert.equal(cents(kpi('Carried over').value), report.summary.carryOver);
  assert.match(kpi('Spent').numFmt, /¥/);

  // Daily: one row per day plus the carried-over row; totals are SUM formulas with cached results.
  const daily = wb.getWorksheet('Daily');
  const header = daily.getRow(3);
  assert.deepEqual(header.values.slice(1), ['Date', 'Day', 'Funds in', 'Spent', 'Purchases', 'Money left']);
  assert.equal(header.getCell(1).fill.fgColor.argb, 'FF1F3A5F');
  assert.equal(header.getCell(1).font.bold, true);
  assert.equal(header.getCell(1).font.color.argb, 'FFFFFFFF');
  assert.equal(header.height, 26);
  assert.equal(daily.getRow(5).height, 20);
  const firstDay = 5;
  const lastDay = firstDay + report.days.length - 1;
  assert.equal(daily.getCell(firstDay, 1).value.toISOString().slice(0, 10), `${MONTH}-01`);
  assert.equal(daily.getCell(firstDay, 1).numFmt, 'yyyy-mm-dd');
  let spentSum = 0;
  for (let r = firstDay; r <= lastDay; r++) spentSum += cents(daily.getCell(r, 4).value || 0);
  assert.equal(spentSum, report.summary.spent);
  const totalRow = daily.getRow(lastDay + 1);
  assert.equal(totalRow.getCell(4).value.formula, `SUM(D4:D${lastDay})`);
  assert.equal(cents(resultOf(totalRow.getCell(4))), report.summary.spent);
  assert.equal(resultOf(totalRow.getCell(5)), report.summary.purchaseCount);
  assert.equal(cents(totalRow.getCell(6).value), report.summary.balance);
  assert.equal(daily.views[0].state, 'frozen');
  assert.equal(daily.views[0].ySplit, 3);
  assert.ok(daily.autoFilter);

  // Products: every product row; spent and quantity totals; widths within bounds.
  const products = wb.getWorksheet('Products');
  const pFirst = 4;
  const pLast = pFirst + report.products.length - 1;
  assert.equal(products.getCell(pFirst, 2).value, report.products[0].name);
  assert.equal(cents(products.getCell(pFirst, 10).value), report.products[0].total);
  assert.equal(cents(resultOf(products.getCell(pLast + 1, 10))), report.summary.spent);
  assert.equal(resultOf(products.getCell(pLast + 1, 6)), report.summary.totalQty);
  assert.equal(products.getCell(pFirst, 11).numFmt, '0.0%');
  assert.equal(products.getColumn(1).width, 6);
  for (let c = 2; c <= 13; c++) {
    const w = products.getColumn(c).width;
    assert.ok(w >= 10 && w <= 42, `products column ${c} width ${w}`);
  }
  assert.equal(products.pageSetup.orientation, 'landscape');
  assert.equal(products.pageSetup.fitToWidth, 1);

  // Details: a band per day, a bold row per purchase, a row per item line.
  const details = wb.getWorksheet('Details');
  let purchaseRows = 0;
  let itemRows = 0;
  let itemTotal = 0;
  details.eachRow((row, r) => {
    if (r <= 3) return;
    if (row.getCell(2).value === 'Purchase') {
      purchaseRows += 1;
      assert.equal(row.getCell(3).font.bold, true);
    } else if (row.getCell(4).value && !row.getCell(2).value) {
      itemRows += 1;
      itemTotal += cents(row.getCell(9).value);
    }
  });
  assert.equal(purchaseRows, report.summary.purchaseCount);
  assert.equal(itemRows, report.summary.lineCount);
  assert.equal(itemTotal, report.summary.spent);
  assert.equal(Object.keys(details._merges).length, report.journal.length + 2); // day bands + title + subtitle
});

test('Excel export follows the language and currency settings', async () => {
  const { s } = seeded();
  const report = s.report.getMonthReport(MONTH);
  const wb = await workbookFor(report, { s, lang: 'ko', currency: 'KRW', decimals: 0 });
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', '일별', '상품별', '상세 내역']);
  const daily = wb.getWorksheet('일별');
  assert.equal(daily.getCell(3, 4).value, '지출');
  assert.equal(daily.getCell(5, 4).font.name, 'Malgun Gothic');
  assert.match(daily.getCell(5, 4).numFmt, /^"₩"#,##0;/);
  assert.match(wb.getWorksheet('요약').getCell('A1').value, /^월간 리포트 · 2026년 4월$/);
});

test('every month of the seeded data exports without errors', async () => {
  const { s } = seeded();
  for (const m of MONTHS) {
    const wb = await workbookFor(s.report.getMonthReport(m), { s });
    assert.equal(wb.worksheets.length, 4, m);
  }
});
