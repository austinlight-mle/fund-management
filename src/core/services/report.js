'use strict';

const v = require('../validate');
const { monthRange, daysInMonth, formatLocalDate } = require('../dates');

// Every purchase item of the month with its product, standard and category
// (full path plus the top-level category it belongs to).
const LINES_SQL = `
WITH RECURSIVE cat (id, root_id, root_name, path) AS (
  SELECT id, id, name, name FROM category WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, cat.root_id, cat.root_name, cat.path || ' > ' || c.name
  FROM category AS c JOIN cat ON c.parent_id = cat.id
)
SELECT pl.id                  AS line_id,
       pu.id                  AS purchase_id,
       pu.date                AS date,
       pu.summary             AS summary,
       pl.product_id          AS product_id,
       pr.name                AS product_name,
       pr.standard            AS standard,
       pr.category_id         AS category_id,
       cat.path               AS category_path,
       cat.root_id            AS root_id,
       cat.root_name          AS root_name,
       pl.price               AS price,
       pl.count               AS count,
       pl.price * pl.count    AS total
FROM purchase_list AS pl
JOIN purchase AS pu ON pu.id = pl.purchase_id
JOIN product AS pr ON pr.id = pl.product_id
LEFT JOIN cat ON cat.id = pr.category_id
WHERE pu.date >= :start AND pu.date < :end
ORDER BY pu.date, pu.id, pl.sort_order, pl.id`;

const pad2 = (n) => String(n).padStart(2, '0');

function createReportService(db, { ledger, clock }) {
  const linesStmt = db.prepare(LINES_SQL);

  /**
   * Everything the Monthly Report page and the Excel export show for a month.
   * Two statements (the month ledger + the item lines) in one read transaction,
   * so all numbers come from the same snapshot.
   */
  function getMonthReport(month) {
    v.month(month);
    const r = monthRange(month);
    return db.transaction(() => build(ledger.getMonth(month), linesStmt.all({ start: r.start, end: r.end })))();
  }

  function build(view, lines) {
    const { month } = view;
    const [y, m] = month.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const today = formatLocalDate(clock.now());
    const spentTotal = view.summary.spent;
    const share = (amount) => (spentTotal > 0 ? amount / spentTotal : 0);

    // ---- items per purchase -------------------------------------------------
    const itemsByPurchase = new Map();
    for (const line of lines) {
      if (!itemsByPurchase.has(line.purchase_id)) itemsByPurchase.set(line.purchase_id, []);
      itemsByPurchase.get(line.purchase_id).push({
        productId: line.product_id,
        name: line.product_name,
        standard: line.standard,
        categoryPath: line.category_path,
        price: line.price,
        count: line.count,
        total: line.total,
      });
    }

    // ---- days ----------------------------------------------------------------
    const entriesByDate = new Map();
    for (const e of view.entries) {
      if (!entriesByDate.has(e.date)) entriesByDate.set(e.date, []);
      entriesByDate.get(e.date).push(e);
    }
    const lastEntryDate = view.entries.length ? view.entries[view.entries.length - 1].date : '';
    const balanceUntil = lastEntryDate > today ? lastEntryDate : today; // no balance for days still ahead
    const days = [];
    let running = 0;
    for (let d = 1; d <= dim; d++) {
      const date = `${month}-${pad2(d)}`;
      const dayEntries = entriesByDate.get(date) || [];
      const day = { date, day: d, carryOver: 0, fundIn: 0, spent: 0, purchaseCount: 0, balance: null, future: date > today };
      for (const e of dayEntries) {
        if (e.kind === 'purchase') {
          day.spent -= e.amount;
          day.purchaseCount += 1;
        } else if (e.fundType === 0) {
          day.carryOver += e.amount;
        } else {
          day.fundIn += e.amount;
        }
      }
      if (dayEntries.length) running = dayEntries[dayEntries.length - 1].runningBalance;
      if (date <= balanceUntil) day.balance = running;
      days.push(day);
    }

    // ---- journal (days that have records) -------------------------------------
    const journal = days
      .filter((day) => entriesByDate.has(day.date))
      .map((day) => ({
        ...day,
        entries: entriesByDate.get(day.date).map((e) =>
          e.kind === 'purchase' ? { ...e, cost: 0 - e.amount, items: itemsByPurchase.get(e.id) || [] } : { ...e }
        ),
      }));

    // ---- categories (top level, with subcategories) -----------------------------
    const roots = new Map();
    for (const line of lines) {
      const rootKey = line.root_id ?? 0;
      if (!roots.has(rootKey)) {
        roots.set(rootKey, { id: line.root_id ?? null, name: line.root_name ?? null, spent: 0, lineCount: 0, qty: 0, children: new Map() });
      }
      const root = roots.get(rootKey);
      root.spent += line.total;
      root.lineCount += 1;
      root.qty += line.count;
      const childKey = line.category_id ?? 0;
      if (!root.children.has(childKey)) {
        const relative = line.category_path && line.category_path.includes(' > ') ? line.category_path.slice(line.category_path.indexOf(' > ') + 3) : null;
        root.children.set(childKey, { id: line.category_id ?? null, name: line.category_id === line.root_id ? null : relative, spent: 0, lineCount: 0 });
      }
      const child = root.children.get(childKey);
      child.spent += line.total;
      child.lineCount += 1;
    }
    const bySpent = (a, b) => b.spent - a.spent || String(a.name ?? '').localeCompare(String(b.name ?? ''));
    const categories = [...roots.values()]
      .map((root) => {
        const children = [...root.children.values()].sort(bySpent).map((c) => ({ ...c, share: share(c.spent) }));
        const hasSub = children.length > 1 || (children.length === 1 && children[0].name !== null);
        return { ...root, share: share(root.spent), children: hasSub ? children : [] };
      })
      .sort(bySpent);

    // ---- products (name + standard) ------------------------------------------
    const productMap = new Map();
    for (const line of lines) {
      if (!productMap.has(line.product_id)) {
        productMap.set(line.product_id, {
          productId: line.product_id,
          name: line.product_name,
          standard: line.standard,
          categoryPath: line.category_path,
          purchases: new Set(),
          lineCount: 0,
          qty: 0,
          total: 0,
          minPrice: line.price,
          maxPrice: line.price,
          firstDate: line.date,
          lastDate: line.date,
        });
      }
      const p = productMap.get(line.product_id);
      p.purchases.add(line.purchase_id);
      p.lineCount += 1;
      p.qty += line.count;
      p.total += line.total;
      p.minPrice = Math.min(p.minPrice, line.price);
      p.maxPrice = Math.max(p.maxPrice, line.price);
      if (line.date < p.firstDate) p.firstDate = line.date;
      if (line.date > p.lastDate) p.lastDate = line.date;
    }
    const products = [...productMap.values()]
      .map(({ purchases, ...p }) => ({
        ...p,
        purchaseCount: purchases.size,
        avgPrice: Math.round(p.total / p.qty),
        share: share(p.total),
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.standard.localeCompare(b.standard));

    // ---- headline numbers ------------------------------------------------------
    const todayMonth = today.slice(0, 7);
    const daysCounted = month < todayMonth ? dim : month === todayMonth ? Number(today.slice(8, 10)) : 0;
    const purchases = view.entries.filter((e) => e.kind === 'purchase');
    const biggest = purchases.reduce((best, e) => (!best || -e.amount > best.cost ? { id: e.id, date: e.date, summary: e.summary, cost: 0 - e.amount } : best), null);
    const prevSpent = view.summary.prevSpent;

    return {
      month,
      prevMonth: view.prevMonth,
      nextMonth: view.nextMonth,
      currentMonth: view.currentMonth,
      today,
      daysInMonth: dim,
      status: view.status,
      summary: {
        carryOver: view.summary.carryOver,
        fundIn: view.summary.fundIn,
        fundInCount: view.summary.fundInCount,
        spent: spentTotal,
        balance: view.summary.balance,
        purchaseCount: view.summary.purchaseCount,
        lineCount: lines.length,
        productCount: products.length,
        totalQty: lines.reduce((sum, l) => sum + l.count, 0),
        daysCounted,
        avgDailySpend: daysCounted ? Math.round(spentTotal / daysCounted) : 0,
        prevSpent,
        spentChange: prevSpent > 0 ? (spentTotal - prevSpent) / prevSpent : null,
        biggestPurchase: biggest && biggest.cost > 0 ? biggest : null,
      },
      days,
      categories,
      products,
      journal,
    };
  }

  return { getMonthReport };
}

module.exports = { createReportService, LINES_SQL };
