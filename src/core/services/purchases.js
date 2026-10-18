'use strict';

const { AppError } = require('../errors');
const v = require('../validate');

const MAX_ITEMS = 500;
const MAX_COUNT = 100000;
const MAX_PRICE = 1e12;

const HEADER_SQL = `
SELECT p.id, p.date, p.summary, p.memo, p.created_at, p.updated_at,
       IFNULL(SUM(pl.price * pl.count), 0) AS cost,
       COUNT(pl.id)                        AS item_count,
       mc.month IS NOT NULL                AS month_confirmed
FROM purchase AS p
LEFT JOIN purchase_list AS pl ON pl.purchase_id = p.id
LEFT JOIN month_closing AS mc ON mc.month = substr(p.date, 1, 7)
WHERE p.id = ?
GROUP BY p.id`;

const ITEMS_SQL = `
SELECT pl.id, pl.purchase_id, pl.product_id, pr.name AS product_name, pr.standard, pr.category_id,
       c.name AS category_name, pl.price, pl.count, pl.price * pl.count AS line_total,
       pl.memo, pl.sort_order
FROM purchase_list AS pl
JOIN product AS pr ON pr.id = pl.product_id
LEFT JOIN category AS c ON c.id = pr.category_id
WHERE pl.purchase_id = ?
ORDER BY pl.sort_order, pl.id`;

function createPurchaseService(db, { ledger, products, actorId }) {
  const headerStmt = db.prepare(HEADER_SQL);
  const itemsStmt = db.prepare(ITEMS_SQL);

  function header(id) {
    const row = headerStmt.get(v.id(id));
    if (!row) throw new AppError('error.notFound');
    return row;
  }

  /** A purchase with its items; `purchase.cost` is the sum of the item line totals. */
  function get(id) {
    const purchase = header(id);
    return { purchase, items: itemsStmt.all(purchase.id) };
  }

  function normalize(input) {
    return {
      summary: v.text(input.summary, 'summary', { max: 200, required: false }),
      date: v.date(input.date),
      memo: v.optionalText(input.memo, 'memo', { max: 1000 }),
    };
  }

  function create(input) {
    const data = normalize(input);
    ledger.assertDateOpen(data.date);
    const info = db
      .prepare('INSERT INTO purchase (summary, date, memo, created_by) VALUES (@summary, @date, @memo, @created_by)')
      .run({ ...data, created_by: actorId() });
    return header(info.lastInsertRowid);
  }

  function update(id, input) {
    const existing = header(id);
    ledger.assertDateOpen(existing.date);
    const data = normalize({ ...existing, ...input });
    ledger.assertDateOpen(data.date);
    db.prepare(
      `UPDATE purchase SET summary = @summary, date = @date, memo = @memo,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
    ).run({ ...data, id: existing.id });
    return header(existing.id);
  }

  function remove(id) {
    const existing = header(id);
    ledger.assertDateOpen(existing.date);
    db.prepare('DELETE FROM purchase WHERE id = ?').run(existing.id); // items cascade
    return { id: existing.id };
  }

  function normalizeItem(item, row) {
    const params = { row };
    let name;
    try {
      name = v.text(item.product_name, 'product', { max: 100 });
    } catch (err) {
      throw new AppError('error.item.productRequired', params);
    }
    let price;
    let count;
    try {
      price = v.money(item.price, 'price', { min: 0, max: MAX_PRICE });
    } catch (err) {
      throw new AppError('error.item.invalidPrice', params);
    }
    try {
      count = v.integer(item.count, 'count', { min: 1, max: MAX_COUNT });
    } catch (err) {
      throw new AppError('error.item.invalidCount', params);
    }
    return {
      id: item.id ? v.id(item.id) : null,
      product_id: item.product_id ? v.id(item.product_id) : null,
      product_name: name,
      standard: v.text(item.standard ?? '', 'standard', { max: 60, required: false }),
      price,
      count,
      memo: v.optionalText(item.memo, 'memo', { max: 200 }),
    };
  }

  /**
   * Replaces the item list of a purchase in one transaction:
   * rows with an id are updated, rows without one inserted, missing rows deleted.
   * A (name, standard) pair that is not registered yet is added to the product table.
   */
  const saveItems = db.transaction((purchaseId, items) => {
    const purchase = header(purchaseId);
    ledger.assertDateOpen(purchase.date);
    if (!Array.isArray(items)) throw new AppError('error.validation.list');
    if (items.length > MAX_ITEMS) throw new AppError('error.item.tooMany', { max: MAX_ITEMS });

    const normalized = items.map((item, i) => normalizeItem(item || {}, i + 1));
    const existingIds = new Set(
      db.prepare('SELECT id FROM purchase_list WHERE purchase_id = ?').pluck().all(purchase.id)
    );
    const createdProducts = [];

    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const resolveProduct = (item) => {
      if (item.product_id) {
        const chosen = db.prepare('SELECT * FROM product WHERE id = ?').get(item.product_id);
        // The typed name/standard win if they were edited after picking a suggestion.
        if (chosen && same(chosen.name, item.product_name) && same(chosen.standard, item.standard)) return chosen.id;
      }
      const { product, created } = products.findOrCreate(item.product_name, item.standard);
      if (created) createdProducts.push({ id: product.id, name: product.name, standard: product.standard });
      return product.id;
    };

    const insert = db.prepare(
      `INSERT INTO purchase_list (purchase_id, product_id, price, count, memo, sort_order)
       VALUES (@purchase_id, @product_id, @price, @count, @memo, @sort_order)`
    );
    const updateStmt = db.prepare(
      `UPDATE purchase_list SET product_id = @product_id, price = @price, count = @count, memo = @memo,
         sort_order = @sort_order, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id AND purchase_id = @purchase_id`
    );

    const keep = new Set();
    normalized.forEach((item, index) => {
      const row = {
        purchase_id: purchase.id,
        product_id: resolveProduct(item),
        price: item.price,
        count: item.count,
        memo: item.memo,
        sort_order: index,
      };
      if (item.id) {
        if (!existingIds.has(item.id)) throw new AppError('error.item.notInPurchase', { row: index + 1 });
        updateStmt.run({ ...row, id: item.id });
        keep.add(item.id);
      } else {
        insert.run(row);
      }
    });
    const del = db.prepare('DELETE FROM purchase_list WHERE id = ?');
    for (const id of existingIds) if (!keep.has(id)) del.run(id);

    return { ...get(purchase.id), createdProducts };
  });

  return { get, create, update, remove, saveItems };
}

module.exports = { createPurchaseService };
