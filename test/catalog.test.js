'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, loginAdmin, throwsCode } = require('./helpers');

test('categories: nested CRUD with ordering, paths and counts', () => {
  const s = setup();
  const food = s.categories.create({ name: 'Food', sort_order: 1 });
  const living = s.categories.create({ name: 'Living', sort_order: 2 });
  const groceries = s.categories.create({ name: 'Groceries', parent_id: food.id });
  const dining = s.categories.create({ name: 'Dining out', parent_id: food.id, description: 'Restaurants' });
  const veg = s.categories.create({ name: 'Vegetables', parent_id: groceries.id });
  const transport = s.categories.create({ name: 'Transport', sort_order: 0 });
  s.products.create({ name: 'Carrot', category_id: veg.id });
  s.products.create({ name: 'Rice', category_id: groceries.id });
  s.products.create({ name: 'Pasta night', category_id: dining.id });

  const list = s.categories.list();
  assert.deepEqual(
    list.map((c) => `${'-'.repeat(c.depth)}${c.name}`),
    ['Transport', 'Food', '-Dining out', '-Groceries', '--Vegetables', 'Living']
  );
  const byName = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(byName.Vegetables.path, 'Food > Groceries > Vegetables');
  assert.equal(byName.Food.child_count, 2);
  assert.equal(byName.Food.product_count, 0);
  assert.equal(byName.Food.total_product_count, 3);
  assert.equal(byName.Groceries.total_product_count, 2);
  assert.deepEqual(s.categories.descendantIds(food.id).sort(), [food.id, groceries.id, dining.id, veg.id].sort());

  const renamed = s.categories.update(dining.id, { name: 'Restaurants', description: null });
  assert.equal(renamed.name, 'Restaurants');
  assert.equal(renamed.description, null);
  // Move Vegetables to the top level and back.
  assert.equal(s.categories.update(veg.id, { parent_id: null }).parent_id, null);
  assert.equal(s.categories.update(veg.id, { parent_id: groceries.id }).parent_id, groceries.id);
  assert.ok(living);
  assert.ok(transport);
});

test('categories: sibling names are unique, cycles and orphan deletes are prevented', () => {
  const s = setup();
  const food = s.categories.create({ name: 'Food' });
  const groceries = s.categories.create({ name: 'Groceries', parent_id: food.id });
  const veg = s.categories.create({ name: 'Vegetables', parent_id: groceries.id });

  throwsCode(assert, () => s.categories.create({ name: 'food' }), 'error.category.duplicateName');
  throwsCode(assert, () => s.categories.create({ name: 'GROCERIES', parent_id: food.id }), 'error.category.duplicateName');
  s.categories.create({ name: 'Groceries' }); // same name at another level is fine
  throwsCode(assert, () => s.categories.create({ name: '   ' }), 'error.validation.required');
  throwsCode(assert, () => s.categories.create({ name: 'x', parent_id: 9999 }), 'error.notFound');

  throwsCode(assert, () => s.categories.update(food.id, { parent_id: food.id }), 'error.category.cycle');
  throwsCode(assert, () => s.categories.update(food.id, { parent_id: veg.id }), 'error.category.cycle');
  throwsCode(assert, () => s.categories.update(groceries.id, { parent_id: veg.id }), 'error.category.cycle');

  throwsCode(assert, () => s.categories.remove(food.id), 'error.category.hasChildren');
  const carrot = s.products.create({ name: 'Carrot', category_id: veg.id });
  const result = s.categories.remove(veg.id);
  assert.equal(result.uncategorizedProducts, 1);
  assert.equal(s.products.get(carrot.id).category_id, null);
  s.categories.remove(groceries.id);
  s.categories.remove(food.id);
  assert.deepEqual(s.categories.list().map((c) => c.name), ['Groceries']);
});

test('products: CRUD, unique names, filters and usage statistics', () => {
  const s = setup();
  loginAdmin(s);
  const food = s.categories.create({ name: 'Food' });
  const dairy = s.categories.create({ name: 'Dairy', parent_id: food.id });
  const transport = s.categories.create({ name: 'Transport' });
  const milk = s.products.create({ name: 'Milk', category_id: dairy.id });
  const cheese = s.products.create({ name: 'Cheese', category_id: dairy.id, memo: 'cheddar' });
  const bus = s.products.create({ name: 'Bus fare', category_id: transport.id });
  const misc = s.products.create({ name: '100% juice' });

  throwsCode(assert, () => s.products.create({ name: 'MILK' }), 'error.product.duplicateName');
  throwsCode(assert, () => s.products.update(cheese.id, { name: ' milk ' }), 'error.product.duplicateName');
  throwsCode(assert, () => s.products.create({ name: 'x', category_id: 999 }), 'error.notFound');

  const p1 = s.purchases.create({ date: '2026-03-01', summary: 'Mart' });
  s.purchases.saveItems(p1.id, [
    { product_id: milk.id, product_name: 'Milk', price: 250000, count: 2 },
    { product_id: milk.id, product_name: 'Milk', price: 240000, count: 1 },
  ]);
  const p2 = s.purchases.create({ date: '2026-03-20', summary: 'Mart again' });
  s.purchases.saveItems(p2.id, [{ product_name: 'milk', price: 260000, count: 3 }]);

  const list = s.products.list();
  assert.deepEqual(list.map((p) => p.name), ['100% juice', 'Bus fare', 'Cheese', 'Milk']);
  const m = list.find((p) => p.id === milk.id);
  assert.equal(m.purchase_count, 2);
  assert.equal(m.total_count, 6);
  assert.equal(m.total_spent, 250000 * 2 + 240000 + 260000 * 3);
  assert.equal(m.last_price, 260000);
  assert.equal(m.last_date, '2026-03-20');
  assert.equal(m.category_path, 'Food > Dairy');

  assert.deepEqual(s.products.list({ categoryId: food.id }).map((p) => p.name), ['Cheese', 'Milk']); // includes subcategories
  assert.deepEqual(s.products.list({ uncategorized: true }).map((p) => p.name), ['100% juice']);
  assert.deepEqual(s.products.list({ search: '%' }).map((p) => p.name), ['100% juice']); // LIKE wildcard escaped
  assert.deepEqual(s.products.list({ search: 'ar' }).map((p) => p.name), ['Bus fare']);

  s.products.update(bus.id, { is_active: false });
  assert.deepEqual(s.products.list({ includeInactive: false }).map((p) => p.name), ['100% juice', 'Cheese', 'Milk']);
  assert.ok(!s.products.searchNames('bus').some((n) => n.standards.some((v) => v.id === bus.id)), 'inactive products are not suggested');

  throwsCode(assert, () => s.products.remove(milk.id), 'error.product.inUse');
  s.products.remove(misc.id);
  assert.equal(s.products.list().length, 3);
});

test('product name suggestions rank exact, then prefix, then substring matches', () => {
  const s = setup();
  loginAdmin(s);
  for (const name of ['Soy milk', 'Milk tea', 'Milk', 'Almond milk', 'Milkshake', 'Bread']) s.products.create({ name });
  const p = s.purchases.create({ date: '2026-01-05' });
  s.purchases.saveItems(p.id, [
    { product_name: 'Almond milk', price: 100, count: 1 },
    { product_name: 'Milkshake', price: 100, count: 1 },
    { product_name: 'Milkshake', price: 100, count: 1 },
  ]);
  const names = s.products.searchNames('milk').map((x) => x.name);
  assert.equal(names[0], 'Milk');
  assert.deepEqual(names.slice(1, 3), ['Milkshake', 'Milk tea']); // prefix matches, most used first
  assert.deepEqual(names.slice(3).sort(), ['Almond milk', 'Soy milk']);
  assert.ok(!names.includes('Bread'));
  assert.equal(s.products.searchNames('', { limit: 3 }).length, 3);
});

test('standards: the same product name once per standard, grouped in suggestions', () => {
  const s = setup();
  loginAdmin(s);
  const dairy = s.categories.create({ name: 'Dairy' });
  const l1 = s.products.create({ name: 'Milk', standard: '1L', category_id: dairy.id });
  const ml500 = s.products.create({ name: 'Milk', standard: ' 500ml ', category_id: dairy.id });
  const plain = s.products.create({ name: 'Bread' });
  assert.equal(ml500.standard, '500ml');
  assert.equal(plain.standard, '');
  throwsCode(assert, () => s.products.create({ name: 'milk', standard: '1l' }), 'error.product.duplicateName'); // case-insensitive pair
  throwsCode(assert, () => s.products.update(ml500.id, { standard: '1L' }), 'error.product.duplicateName');
  s.products.create({ name: 'Milk' }); // no standard is its own variant
  assert.deepEqual(s.products.list({ search: 'milk' }).map((p) => p.standard), ['', '1L', '500ml']);
  assert.deepEqual(s.products.list({ search: '500' }).map((p) => p.id), [ml500.id]); // search covers the standard

  // Buy 500ml twice and 1L once: the most-bought standard is listed first.
  const p = s.purchases.create({ date: '2026-02-01', summary: 'Mart' });
  s.purchases.saveItems(p.id, [
    { product_name: 'Milk', standard: '500ml', price: 1500, count: 1 },
    { product_name: 'MILK', standard: '500ML', price: 1600, count: 2 },
    { product_name: 'Milk', standard: '1L', price: 2500, count: 1 },
  ]);
  const p2 = s.purchases.create({ date: '2026-02-03', summary: 'Mart' });
  s.purchases.saveItems(p2.id, [{ product_id: ml500.id, product_name: 'Milk', standard: '500ml', price: 1550, count: 1 }]);
  const [group] = s.products.searchNames('mil');
  assert.equal(group.name, 'Milk');
  assert.equal(group.variant_count, 3);
  assert.deepEqual(group.standards.map((v) => v.standard), ['500ml', '1L', '']);
  assert.equal(group.standards[0].last_price, 1550);
  assert.deepEqual(s.products.variants('milk').map((v) => v.id).slice(0, 2), [ml500.id, l1.id]);
  assert.deepEqual(s.products.variants('nothing'), []);

  // A new standard typed in a purchase keeps the registered spelling and category.
  const res = s.purchases.saveItems(p2.id, [
    { product_id: ml500.id, product_name: 'Milk', standard: '500ml', price: 1550, count: 1 },
    { product_name: 'milk', standard: '2L', price: 4200, count: 1 },
  ]);
  assert.deepEqual(res.createdProducts, [{ id: res.items[1].product_id, name: 'Milk', standard: '2L' }]);
  assert.equal(s.products.get(res.items[1].product_id).category_id, dairy.id);
  assert.equal(res.items[1].standard, '2L');
  // A stale product_id whose standard was changed resolves by the typed standard.
  const res2 = s.purchases.saveItems(p2.id, [{ id: res.items[0].id, product_id: ml500.id, product_name: 'Milk', standard: '1L', price: 2500, count: 1 }]);
  assert.equal(res2.items[0].product_id, l1.id);
  assert.deepEqual(res2.createdProducts, []);
});

test('purchases: items are saved transactionally and unknown products are registered', () => {
  const s = setup();
  loginAdmin(s);
  const milk = s.products.create({ name: 'Milk' });
  const p = s.purchases.create({ date: '2026-04-02', summary: 'Weekly shopping' });
  assert.equal(p.cost, 0);

  let res = s.purchases.saveItems(p.id, [
    { product_id: milk.id, product_name: 'Milk', price: 250000, count: 2 },
    { product_name: 'Bread', price: 320000, count: 3 },
    { product_name: '  bread ', price: 100000, count: 1 }, // same new product, different case/spaces
  ]);
  assert.equal(res.purchase.cost, 250000 * 2 + 320000 * 3 + 100000);
  assert.equal(res.purchase.item_count, 3);
  assert.deepEqual(res.createdProducts.map((c) => c.name), ['Bread']);
  assert.equal(res.items[1].product_id, res.items[2].product_id);
  assert.deepEqual(res.items.map((i) => i.line_total), [500000, 960000, 100000]);

  // Update one row, delete one, add one; a stale product_id with a changed name resolves by name.
  const [mRow, bRow] = res.items;
  res = s.purchases.saveItems(p.id, [
    { id: bRow.id, product_id: bRow.product_id, product_name: 'Bread', price: 300000, count: 2 },
    { id: mRow.id, product_id: milk.id, product_name: 'Oat milk', price: 410000, count: 1 },
    { product_name: 'Eggs', price: 59000, count: 12 },
  ]);
  assert.deepEqual(res.items.map((i) => i.product_name), ['Bread', 'Oat milk', 'Eggs']);
  assert.equal(res.items[0].id, bRow.id);
  assert.equal(res.purchase.cost, 600000 + 410000 + 59000 * 12);
  assert.deepEqual(res.createdProducts.map((c) => c.name).sort(), ['Eggs', 'Oat milk']);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM purchase_list WHERE purchase_id = ?').pluck().get(p.id), 3);
  assert.equal(s.ledger.getMonth('2026-04').entries[0].amount, -res.purchase.cost);

  // Invalid input rolls back everything (no new product, no partial rows).
  const before = s.products.list().length;
  throwsCode(assert, () => s.purchases.saveItems(p.id, [{ product_name: 'Ghost', price: 100, count: 1 }, { product_name: 'X', price: 100, count: 0 }]), 'error.item.invalidCount');
  throwsCode(assert, () => s.purchases.saveItems(p.id, [{ product_name: '', price: 100, count: 1 }]), 'error.item.productRequired');
  throwsCode(assert, () => s.purchases.saveItems(p.id, [{ product_name: 'A', price: -1, count: 1 }]), 'error.item.invalidPrice');
  throwsCode(assert, () => s.purchases.saveItems(p.id, [{ product_name: 'A', price: 1.5, count: 1 }]), 'error.item.invalidPrice');
  const other = s.purchases.create({ date: '2026-04-03' });
  throwsCode(assert, () => s.purchases.saveItems(other.id, [{ id: bRow.id, product_name: 'Bread', price: 1, count: 1 }]), 'error.item.notInPurchase');
  assert.equal(s.products.list().length, before);
  assert.equal(s.purchases.get(p.id).purchase.cost, 600000 + 410000 + 59000 * 12);

  // Header edits and cascading delete.
  assert.equal(s.purchases.update(p.id, { summary: '  Big shop ' }).summary, 'Big shop');
  throwsCode(assert, () => s.purchases.update(p.id, { date: '2026-02-30' }), 'error.validation.date');
  s.purchases.remove(p.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM purchase_list WHERE purchase_id = ?').pluck().get(p.id), 0);
  throwsCode(assert, () => s.purchases.get(p.id), 'error.notFound');
});

test('funds: only positive fund inputs can be created and edited', () => {
  const s = setup();
  loginAdmin(s);
  const f = s.funds.create({ amount: 300000000, date: '2026-06-25', memo: ' Salary ' });
  assert.equal(f.type, 1);
  assert.equal(f.memo, 'Salary');
  throwsCode(assert, () => s.funds.create({ amount: 0, date: '2026-06-25' }), 'error.validation.range');
  throwsCode(assert, () => s.funds.create({ amount: -5, date: '2026-06-25' }), 'error.validation.range');
  throwsCode(assert, () => s.funds.create({ amount: 10, date: '2026-6-25' }), 'error.validation.date');
  assert.equal(s.funds.update(f.id, { amount: 310000000, date: '2026-07-01' }).date, '2026-07-01');
  s.funds.create({ amount: 5000, date: '2025-12-31' });
  assert.deepEqual(s.funds.list({ year: 2026 }).map((r) => r.amount), [310000000]);
  s.funds.remove(f.id);
  assert.equal(s.funds.list({ year: 2026 }).length, 0);
});
