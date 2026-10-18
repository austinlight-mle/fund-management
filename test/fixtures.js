'use strict';

// Shared seed data for the ledger and report tests.

const { prng, pad2 } = require('./helpers');
const { daysInMonth } = require('../src/core/dates');

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

// [name, standard] pairs; several names exist in more than one standard.
const PRODUCTS = [
  ['Milk', '1L'], ['Milk', '500ml'], ['Bread', ''], ['Eggs', '30'], ['Eggs', '10'], ['Apples', ''], ['Rice', '10kg'],
  ['Rice', '4kg'], ['Coffee', 'Beans 1kg'], ['Bus fare', ''], ['Taxi', ''], ['Fuel', ''], ['Shampoo', '500ml'],
  ['Toothpaste', ''], ['Movie ticket', ''], ['Book', ''], ['Kimchi', '1kg'], ['두부', ''], ['라면', '5개입'], ['우유', '1L'],
  ['Batteries', 'AA'], ['Batteries', 'AAA'], ['Light bulb', ''], ['Notebook', 'A5'],
];

const sum = (list, fn) => list.reduce((acc, x) => acc + fn(x), 0);

/**
 * Inserts pseudo-random but reproducible data through the services and keeps
 * an independent record of everything inserted, to compute expected numbers.
 */
function seed(s, { seedValue = 20261018, months = MONTHS } = {}) {
  const r = prng(seedValue);
  const food = s.categories.create({ name: 'Food' });
  const groceries = s.categories.create({ name: 'Groceries', parent_id: food.id });
  const dining = s.categories.create({ name: 'Dining', parent_id: food.id });
  const transport = s.categories.create({ name: 'Transport' });
  // About half of the products are registered up front; the rest get auto-created by saveItems.
  PRODUCTS.slice(0, 12).forEach(([name, standard], i) =>
    s.products.create({ name, standard, category_id: [groceries.id, transport.id, null, food.id, dining.id][i % 5] })
  );

  const data = { funds: [], purchases: [] };
  for (const month of months) {
    const [y, m] = month.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const fundCount = r.int(1, 3);
    for (let i = 0; i < fundCount; i++) {
      const amount = r.int(50, 400) * 10000 * 100; // 500,000 – 4,000,000 (minor units)
      const date = `${month}-${pad2(r.int(1, dim))}`;
      const f = s.funds.create({ amount, date, memo: `Income ${i + 1}` });
      data.funds.push({ id: f.id, date, amount });
    }
    const purchaseCount = r.int(6, 14);
    for (let i = 0; i < purchaseCount; i++) {
      // Some purchases share a date with funds/other purchases on purpose.
      const date = `${month}-${pad2(i === 0 ? 1 : r.int(1, dim))}`;
      const p = s.purchases.create({ date, summary: `Purchase ${month} #${i + 1}` });
      const itemCount = i === 1 ? 0 : r.int(1, 6); // one purchase without items per month
      const items = [];
      for (let k = 0; k < itemCount; k++) {
        const [name, standard] = r.pick(PRODUCTS);
        items.push({ product_name: name, standard, price: r.int(1, 2000) * 10 * 100, count: r.int(1, 5) });
      }
      s.purchases.saveItems(p.id, items);
      data.purchases.push({ id: p.id, date, items, cost: sum(items, (it) => it.price * it.count) });
    }
  }
  return { data, groceries, transport, food, dining };
}

/** Independent calculation of a month's ledger from the inserted data. */
function expectedMonth(data, month, carryOver = null) {
  const funds = data.funds.filter((f) => f.date.startsWith(month));
  const purchases = data.purchases.filter((p) => p.date.startsWith(month));
  const entries = [];
  if (carryOver !== null) entries.push({ kind: 'fund', fundType: 0, id: null, date: `${month}-01`, amount: carryOver, group: 0 });
  for (const f of funds) entries.push({ kind: 'fund', fundType: 1, id: f.id, date: f.date, amount: f.amount, group: 1 });
  for (const p of purchases) entries.push({ kind: 'purchase', fundType: null, id: p.id, date: p.date, amount: 0 - p.cost, group: 2 });
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.group - b.group || (a.id ?? 0) - (b.id ?? 0)));
  let running = 0;
  for (const e of entries) {
    running += e.amount;
    e.runningBalance = running;
  }
  const fundIn = sum(funds, (f) => f.amount);
  const spent = sum(purchases, (p) => p.cost);
  return { fundIn, spent, carryOver: carryOver ?? 0, balance: (carryOver ?? 0) + fundIn - spent, entries, purchaseCount: purchases.length };
}

module.exports = { MONTHS, PRODUCTS, sum, seed, expectedMonth };
