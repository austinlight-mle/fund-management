'use strict';

const { AppError, isUniqueViolation } = require('../errors');
const v = require('../validate');

const LIST_SQL = `
WITH RECURSIVE tree (id, depth, path) AS (
  SELECT id, 0, name FROM category WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, t.depth + 1, t.path || ' > ' || c.name
  FROM category AS c JOIN tree AS t ON c.parent_id = t.id
)
SELECT c.id, c.name, c.parent_id, c.description, c.sort_order, c.created_at, c.updated_at,
       t.depth, t.path,
       IFNULL(ch.child_count, 0)   AS child_count,
       IFNULL(pr.product_count, 0) AS product_count
FROM category AS c
JOIN tree AS t ON t.id = c.id
LEFT JOIN (SELECT parent_id, COUNT(*) AS child_count FROM category GROUP BY parent_id) AS ch ON ch.parent_id = c.id
LEFT JOIN (SELECT category_id, COUNT(*) AS product_count FROM product GROUP BY category_id) AS pr ON pr.category_id = c.id`;

const DESCENDANTS_SQL = `
WITH RECURSIVE sub (id) AS (
  SELECT ?
  UNION ALL
  SELECT c.id FROM category AS c JOIN sub ON c.parent_id = sub.id
)
SELECT id FROM sub`;

/** Orders a flat category list depth-first (siblings by sort_order, then name). */
function orderTree(rows) {
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parent_id ?? 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  const out = [];
  const walk = (parentKey) => {
    for (const row of byParent.get(parentKey) || []) {
      out.push(row);
      walk(row.id);
    }
  };
  walk(0);
  // Each row's product total including all subcategories.
  const byId = new Map(out.map((r) => [r.id, r]));
  for (const r of out) r.total_product_count = r.product_count;
  for (const r of [...out].reverse()) {
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).total_product_count += r.total_product_count;
  }
  return out;
}

function createCategoryService(db) {
  const getStmt = db.prepare('SELECT * FROM category WHERE id = ?');
  const descendantsStmt = db.prepare(DESCENDANTS_SQL).pluck();

  function list() {
    return orderTree(db.prepare(LIST_SQL).all());
  }

  function get(id) {
    const row = getStmt.get(v.id(id));
    if (!row) throw new AppError('error.notFound');
    return row;
  }

  function descendantIds(id) {
    return descendantsStmt.all(v.id(id));
  }

  function normalize(input) {
    return {
      name: v.text(input.name, 'name', { max: 100 }),
      parent_id: v.optionalId(input.parent_id, 'parent'),
      description: v.optionalText(input.description, 'description', { max: 500 }),
      sort_order: input.sort_order === undefined || input.sort_order === '' ? 0 : v.integer(input.sort_order, 'sortOrder', { min: -9999, max: 9999 }),
    };
  }

  function write(fn) {
    try {
      return fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('error.category.duplicateName');
      throw err;
    }
  }

  function create(input) {
    const data = normalize(input);
    if (data.parent_id) get(data.parent_id);
    const info = write(() =>
      db
        .prepare('INSERT INTO category (name, parent_id, description, sort_order) VALUES (@name, @parent_id, @description, @sort_order)')
        .run(data)
    );
    return get(info.lastInsertRowid);
  }

  function update(id, input) {
    const existing = get(id);
    const data = normalize({ ...existing, ...input });
    if (data.parent_id) {
      get(data.parent_id);
      // The new parent may not be the category itself or any of its descendants.
      if (descendantIds(existing.id).includes(data.parent_id)) throw new AppError('error.category.cycle');
    }
    write(() =>
      db
        .prepare(
          `UPDATE category SET name = @name, parent_id = @parent_id, description = @description, sort_order = @sort_order,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
        )
        .run({ ...data, id: existing.id })
    );
    return get(existing.id);
  }

  const remove = db.transaction((id) => {
    const existing = get(id);
    const children = db.prepare('SELECT COUNT(*) FROM category WHERE parent_id = ?').pluck().get(existing.id);
    if (children > 0) throw new AppError('error.category.hasChildren', { count: children });
    const products = db.prepare('SELECT COUNT(*) FROM product WHERE category_id = ?').pluck().get(existing.id);
    // product.category_id is ON DELETE SET NULL: its products become uncategorized.
    db.prepare('DELETE FROM category WHERE id = ?').run(existing.id);
    return { id: existing.id, uncategorizedProducts: products };
  });

  return { list, get, create, update, remove, descendantIds };
}

module.exports = { createCategoryService, orderTree };
