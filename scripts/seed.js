'use strict';

/*
 * Creates a demo database with sample categories, products, fund inputs and
 * purchases for the last three months (confirmed) and the current month (open).
 *
 *   node scripts/seed.js <data-dir> [--force]
 *
 * Used by `npm run demo` (data dir "demo-data"). An existing database is left
 * alone unless --force is given. Sign in with admin / admin.
 */

const fs = require('fs');
const path = require('path');
const { openDatabase } = require('../src/core/db');
const { createServices } = require('../src/core/services');
const { addMonths, formatLocalDate, daysInMonth } = require('../src/core/dates');

const dataDir = path.resolve(process.argv[2] || 'demo-data');
const force = process.argv.includes('--force');
const dbFile = path.join(dataDir, 'fund-manage.db');

if (fs.existsSync(dbFile) && !force) {
  console.log(`Demo database already exists: ${dbFile} (use --force to recreate)`);
  process.exit(0);
}
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });

const db = openDatabase(dbFile);
const s = createServices(db);
const yuan = (n) => Math.round(n * 100); // default currency is CNY

const tree = {
  Food: ['Groceries', 'Dining out', 'Coffee & snacks'],
  Transport: ['Public transport', 'Fuel'],
  Living: ['Utilities', 'Household'],
  Health: [],
  Entertainment: [],
};
const cat = {};
Object.entries(tree).forEach(([parent, children], i) => {
  cat[parent] = s.categories.create({ name: parent, sort_order: i }).id;
  children.forEach((child) => {
    cat[child] = s.categories.create({ name: child, parent_id: cat[parent] }).id;
  });
});

// [name, standard, category, price in yuan]; some names exist in several standards.
const catalog = [
  ['Milk', '1L', 'Groceries', 12.5], ['Milk', '2L', 'Groceries', 22], ['Eggs', '30', 'Groceries', 28.9],
  ['Eggs', '10', 'Groceries', 10.9], ['Rice', '10kg', 'Groceries', 65], ['Rice', '4kg', 'Groceries', 29.9],
  ['Apples', '', 'Groceries', 15.8], ['Tofu', '', 'Groceries', 4.5], ['Instant noodles', '5-pack', 'Groceries', 13.9],
  ['Kimchi', '1kg', 'Groceries', 25], ['Lunch set', '', 'Dining out', 32], ['Dinner with friends', '', 'Dining out', 168],
  ['Americano', 'Tall', 'Coffee & snacks', 22], ['Americano', 'Grande', 'Coffee & snacks', 26], ['Bakery', '', 'Coffee & snacks', 18],
  ['Subway fare', '', 'Public transport', 4], ['Bus fare', '', 'Public transport', 2], ['Gasoline', '', 'Fuel', 350],
  ['Electricity bill', '', 'Utilities', 180], ['Internet', '', 'Utilities', 129], ['Detergent', '3L', 'Household', 39.9],
  ['Toilet paper', '24 rolls', 'Household', 45.9], ['Batteries', 'AA', 'Household', 19.9], ['Batteries', 'AAA', 'Household', 17.9],
  ['Pharmacy', '', 'Health', 36], ['Movie ticket', '', 'Entertainment', 55],
];
for (const [name, standard, category] of catalog) s.products.create({ name, standard, category_id: cat[category] });

const productKey = (name, standard) => `${name}|${standard}`;
const priceOf = Object.fromEntries(catalog.map(([name, standard, , price]) => [productKey(name, standard), price]));
const item = (key, count) => {
  const [name, standard] = key.split('|');
  return { product_name: name, standard, price: yuan(priceOf[key]), count };
};
const shops = [
  ['Supermarket weekly shopping', ['Milk|1L', 'Milk|2L', 'Eggs|30', 'Eggs|10', 'Apples|', 'Tofu|', 'Kimchi|1kg', 'Instant noodles|5-pack', 'Rice|4kg']],
  ['Lunch', ['Lunch set|']],
  ['Coffee', ['Americano|Tall', 'Americano|Grande', 'Bakery|']],
  ['Commute', ['Subway fare|', 'Bus fare|']],
  ['Gas station', ['Gasoline|']],
  ['Daiso', ['Detergent|3L', 'Toilet paper|24 rolls', 'Batteries|AA', 'Batteries|AAA']],
  ['Friday dinner', ['Dinner with friends|']],
  ['Pharmacy', ['Pharmacy|']],
  ['Movie night', ['Movie ticket|']],
];

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const today = formatLocalDate(new Date());
const current = today.slice(0, 7);
const months = [-3, -2, -1, 0].map((d) => addMonths(current, d));

for (const month of months) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = month === current ? Number(today.slice(8, 10)) : daysInMonth(y, m);
  s.funds.create({ amount: yuan(12000), date: `${month}-01`, memo: 'Salary' });
  if (rand() > 0.5) s.funds.create({ amount: yuan(800), date: `${month}-${String(Math.min(15, lastDay)).padStart(2, '0')}`, memo: 'Side job' });
  const bills = s.purchases.create({ date: `${month}-01`, summary: 'Monthly bills' });
  s.purchases.saveItems(bills.id, [
    { ...item('Electricity bill|', 1), price: yuan(priceOf['Electricity bill|'] + Math.floor(rand() * 9) * 5.5) },
    item('Internet|', 1),
  ]);
  const count = Math.max(3, Math.round((lastDay / 30) * 18));
  for (let i = 0; i < count; i++) {
    const [summary, products] = pick(shops);
    const day = 1 + Math.floor(rand() * lastDay);
    const p = s.purchases.create({ date: `${month}-${String(day).padStart(2, '0')}`, summary });
    const items = products.filter(() => products.length === 1 || rand() > 0.45).map((key) => item(key, 1 + Math.floor(rand() * 3)));
    s.purchases.saveItems(p.id, items.length ? items : [item(products[0], 1)]);
  }
  if (month !== current) s.ledger.confirmMonth(month);
}

const view = s.ledger.getMonth(current);
console.log(`Demo database created: ${dbFile}`);
console.log(`  months: ${months.join(', ')} (all but the current month confirmed)`);
console.log(`  current month money left: ${view.summary.balance / 100}`);
console.log('  sign in with admin / admin');
db.close();
