'use strict';

const { AppError, isUniqueViolation } = require('../errors');
const v = require('../validate');

const CATEGORY_PATH_CTE = `
cat_path (id, path) AS (
  SELECT id, name FROM category WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, cp.path || ' > ' || c.name FROM category AS c JOIN cat_path AS cp ON c.parent_id = cp.id
)`;

// Usage statistics per product and the most recent unit price paid.
const USAGE_CTES = `
usage AS (
  SELECT pl.product_id,
         COUNT(DISTINCT pl.purchase_id) AS purchase_count,
         SUM(pl.count)                  AS total_count,
         SUM(pl.price * pl.count)       AS total_spent,
         MAX(pu.date)                   AS last_date
  FROM purchase_list AS pl
  JOIN purchase AS pu ON pu.id = pl.purchase_id
  GROUP BY pl.product_id
),
last_price AS (
  SELECT product_id, price
  FROM (
    SELECT pl.product_id, pl.price,
           ROW_NUMBER() OVER (PARTITION BY pl.product_id ORDER BY pu.date DESC, pl.id DESC) AS rn
    FROM purchase_list AS pl
    JOIN purchase AS pu ON pu.id = pl.purchase_id
  )
  WHERE rn = 1
)`;

const SELECT_COLUMNS = `
  p.id, p.name, p.standard, p.category_id, p.memo, p.is_active, p.created_at, p.updated_at,
  cp.path                     AS category_path,
  IFNULL(u.purchase_count, 0) AS purchase_count,
  IFNULL(u.total_count, 0)    AS total_count,
  IFNULL(u.total_spent, 0)    AS total_spent,
  u.last_date                 AS last_date,
  lp.price                    AS last_price`;

const JOINS = `
FROM product AS p
LEFT JOIN cat_path AS cp ON cp.id = p.category_id
LEFT JOIN usage AS u ON u.product_id = p.id
LEFT JOIN last_price AS lp ON lp.product_id = p.id`;

const ORDER = 'p.name COLLATE NOCASE, p.standard COLLATE NOCASE';

const escapeLike = (term) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const likePattern = (term) => `%${escapeLike(term)}%`;

function createProductService(db, { categories }) {
  const getStmt = db.prepare('SELECT * FROM product WHERE id = ?');
  // name and standard are COLLATE NOCASE columns
  const byKeyStmt = db.prepare('SELECT * FROM product WHERE name = ? AND standard = ?');
  const usageStmt = db.prepare('SELECT COUNT(*) FROM purchase_list WHERE product_id = ?').pluck();

  function get(id) {
    const row = getStmt.get(v.id(id));
    if (!row) throw new AppError('error.notFound');
    return row;
  }

  function find(name, standard = '') {
    return byKeyStmt.get(String(name).trim(), String(standard ?? '').trim()) || null;
  }

  function list({ search = '', categoryId = null, uncategorized = false, includeInactive = true } = {}) {
    const term = typeof search === 'string' ? search.trim() : '';
    const where = [];
    const params = {};
    if (term) {
      where.push("(p.name LIKE @term ESCAPE '\\' OR p.standard LIKE @term ESCAPE '\\')");
      params.term = likePattern(term);
    }
    if (uncategorized) {
      where.push('p.category_id IS NULL');
    } else if (categoryId) {
      // The selected category and all of its subcategories.
      where.push('p.category_id IN (SELECT value FROM json_each(@ids))');
      params.ids = JSON.stringify(categories.descendantIds(categoryId));
    }
    if (!includeInactive) where.push('p.is_active = 1');
    const sql = `WITH RECURSIVE ${CATEGORY_PATH_CTE}, ${USAGE_CTES}
      SELECT ${SELECT_COLUMNS} ${JOINS}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${ORDER}`;
    return db.prepare(sql).all(params);
  }

  /** Every standard registered for one product name (most used first). */
  function variants(name, { includeInactive = false } = {}) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return [];
    const sql = `WITH RECURSIVE ${CATEGORY_PATH_CTE}, ${USAGE_CTES}
      SELECT ${SELECT_COLUMNS} ${JOINS}
      WHERE p.name = @name ${includeInactive ? '' : 'AND p.is_active = 1'}
      ORDER BY IFNULL(u.purchase_count, 0) DESC, u.last_date DESC, p.standard COLLATE NOCASE`;
    return db.prepare(sql).all({ name: n });
  }

  /**
   * Autocomplete for the product-name field: one entry per distinct name with
   * all of its standards. Exact match first, then prefix, then substring;
   * frequently bought names first.
   */
  function searchNames(term, { limit = 10 } = {}) {
    const q = typeof term === 'string' ? term.trim() : '';
    const sql = `WITH RECURSIVE ${CATEGORY_PATH_CTE}, ${USAGE_CTES},
      variants AS (
        SELECT ${SELECT_COLUMNS} ${JOINS}
        WHERE p.is_active = 1 AND (@q = '' OR p.name LIKE @pattern ESCAPE '\\')
      )
      SELECT MIN(name) AS name,
             COUNT(*) AS variant_count,
             SUM(purchase_count) AS purchase_count,
             json_group_array(json_object(
               'id', id, 'standard', standard, 'category_id', category_id, 'category_path', category_path,
               'purchase_count', purchase_count, 'last_price', last_price, 'last_date', last_date
             ) ORDER BY purchase_count DESC, last_date DESC, standard COLLATE NOCASE) AS standards
      FROM variants
      GROUP BY name COLLATE NOCASE
      ORDER BY CASE
                 WHEN MIN(name) = @q COLLATE NOCASE THEN 0
                 WHEN MIN(name) LIKE @prefix ESCAPE '\\' THEN 1
                 ELSE 2
               END,
               SUM(purchase_count) DESC,
               MIN(name) COLLATE NOCASE
      LIMIT @limit`;
    return db
      .prepare(sql)
      .all({ q, pattern: likePattern(q), prefix: `${escapeLike(q)}%`, limit: v.integer(limit, 'limit', { min: 1, max: 100 }) })
      .map((row) => ({ ...row, standards: JSON.parse(row.standards) }));
  }

  function normalize(input) {
    return {
      name: v.text(input.name, 'name', { max: 100 }),
      standard: v.text(input.standard ?? '', 'standard', { max: 60, required: false }),
      category_id: v.optionalId(input.category_id, 'category'),
      memo: v.optionalText(input.memo, 'memo', { max: 500 }),
      is_active: input.is_active === undefined ? 1 : v.bool(input.is_active) ? 1 : 0,
    };
  }

  function write(fn) {
    try {
      return fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('error.product.duplicateName');
      throw err;
    }
  }

  function create(input) {
    const data = normalize(input);
    if (data.category_id) categories.get(data.category_id);
    const info = write(() =>
      db
        .prepare(
          `INSERT INTO product (name, standard, category_id, memo, is_active)
           VALUES (@name, @standard, @category_id, @memo, @is_active)`
        )
        .run(data)
    );
    return get(info.lastInsertRowid);
  }

  /**
   * Returns the product for (name, standard), creating it when missing. A new
   * standard of an existing name keeps that name's spelling and category.
   */
  function findOrCreate(name, standard = '') {
    const found = find(name, standard);
    if (found) return { product: found, created: false };
    const sibling = db
      .prepare('SELECT name, category_id FROM product WHERE name = ? ORDER BY category_id IS NULL, id LIMIT 1')
      .get(String(name).trim());
    const product = create({
      name: sibling ? sibling.name : name,
      standard,
      category_id: sibling ? sibling.category_id : null,
    });
    return { product, created: true };
  }

  function update(id, input) {
    const existing = get(id);
    const data = normalize({ ...existing, ...input });
    if (data.category_id) categories.get(data.category_id);
    write(() =>
      db
        .prepare(
          `UPDATE product SET name = @name, standard = @standard, category_id = @category_id, memo = @memo,
             is_active = @is_active, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
        )
        .run({ ...data, id: existing.id })
    );
    return get(existing.id);
  }

  function remove(id) {
    const existing = get(id);
    const used = usageStmt.get(existing.id);
    if (used > 0) throw new AppError('error.product.inUse', { count: used });
    db.prepare('DELETE FROM product WHERE id = ?').run(existing.id);
    return { id: existing.id };
  }

  return { list, variants, searchNames, get, find, findOrCreate, create, update, remove };
}

module.exports = { createProductService };
