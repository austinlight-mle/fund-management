'use strict';

const { AppError } = require('../errors');
const v = require('../validate');
const { monthRange, monthOf, addMonths, formatLocalDate } = require('../dates');

/*
 * One query returns everything the purchase page needs for a month:
 *   - every fund record (carried over / input) and purchase of the month, with
 *     the purchase cost summed from purchase_list (price * count),
 *   - a running balance per row (window function),
 *   - summary totals (carried over, funds in, spent, money left),
 *   - the previous month's balance computed the same way, so the carried-over
 *     amount can be checked against it,
 *   - confirmation state of this and the previous month and the carry-over
 *     record already written for the next month.
 * The summary CTE always yields exactly one row; LEFT JOIN-ing the ledger rows
 * onto it guarantees one result row even for an empty month.
 */
const MONTH_LEDGER_SQL = `
WITH
purchase_cost AS (
  SELECT p.id, p.date, p.summary,
         IFNULL(SUM(pl.price * pl.count), 0) AS cost,
         COUNT(pl.id)                        AS item_count
  FROM purchase AS p
  LEFT JOIN purchase_list AS pl ON pl.purchase_id = p.id
  WHERE p.date >= :prev_start AND p.date < :end
  GROUP BY p.id
),
entries AS (
  SELECT 'fund'                              AS kind,
         f.id                                AS id,
         f.type                              AS fund_type,
         f.date                              AS date,
         IFNULL(f.memo, '')                  AS summary,
         f.amount                            AS amount,
         NULL                                AS item_count,
         f.source_month                      AS source_month,
         CASE f.type WHEN 0 THEN 0 ELSE 1 END AS sort_group
  FROM fund AS f
  WHERE f.date >= :start AND f.date < :end
  UNION ALL
  SELECT 'purchase', pc.id, NULL, pc.date, pc.summary, -pc.cost, pc.item_count, NULL, 2
  FROM purchase_cost AS pc
  WHERE pc.date >= :start
),
ledger AS (
  SELECT e.*,
         SUM(e.amount) OVER (
           ORDER BY e.date, e.sort_group, e.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS running_balance
  FROM entries AS e
),
fund_totals AS (
  SELECT
    IFNULL(SUM(CASE WHEN f.date >= :start AND f.type = 0 THEN f.amount END), 0) AS carry_over,
    COUNT(CASE WHEN f.date >= :start AND f.type = 0 THEN 1 END)                AS carry_over_count,
    IFNULL(SUM(CASE WHEN f.date >= :start AND f.type = 1 THEN f.amount END), 0) AS fund_in,
    COUNT(CASE WHEN f.date >= :start AND f.type = 1 THEN 1 END)                AS fund_in_count,
    IFNULL(SUM(CASE WHEN f.date <  :start THEN f.amount END), 0)               AS prev_funds,
    COUNT(CASE WHEN f.date <  :start THEN 1 END)                               AS prev_fund_count
  FROM fund AS f
  WHERE f.date >= :prev_start AND f.date < :end
),
purchase_totals AS (
  SELECT
    IFNULL(SUM(CASE WHEN pc.date >= :start THEN pc.cost END), 0)       AS spent,
    COUNT(CASE WHEN pc.date >= :start THEN 1 END)                      AS purchase_count,
    IFNULL(SUM(CASE WHEN pc.date >= :start THEN pc.item_count END), 0) AS line_count,
    IFNULL(SUM(CASE WHEN pc.date <  :start THEN pc.cost END), 0)       AS prev_spent,
    COUNT(CASE WHEN pc.date <  :start THEN 1 END)                      AS prev_purchase_count
  FROM purchase_cost AS pc
),
summary AS (
  SELECT
    ft.carry_over,
    ft.carry_over_count,
    ft.fund_in,
    ft.fund_in_count,
    pt.spent,
    pt.purchase_count,
    pt.line_count,
    ft.carry_over + ft.fund_in - pt.spent        AS balance,
    ft.prev_funds - pt.prev_spent                AS prev_balance,
    pt.prev_spent                                AS prev_spent,
    ft.prev_fund_count + pt.prev_purchase_count  AS prev_entry_count,
    mc.month IS NOT NULL                         AS is_confirmed,
    mc.confirmed_at                              AS confirmed_at,
    mc.closing_balance                           AS confirmed_balance,
    pmc.month IS NOT NULL                        AS prev_is_confirmed,
    nf.id                                        AS next_carry_over_id,
    nf.amount                                    AS next_carry_over_amount
  FROM fund_totals AS ft
  CROSS JOIN purchase_totals AS pt
  LEFT JOIN month_closing AS mc  ON mc.month  = :month
  LEFT JOIN month_closing AS pmc ON pmc.month = :prev_month
  LEFT JOIN fund AS nf ON nf.type = 0 AND nf.date = :end
)
SELECT s.*,
       l.kind, l.id, l.fund_type, l.date, l.summary, l.amount,
       l.item_count, l.source_month, l.running_balance
FROM summary AS s
LEFT JOIN ledger AS l ON 1 = 1
ORDER BY l.date, l.sort_group, l.id
`;

function createLedgerService(db, { clock, actorId }) {
  const ledgerStmt = db.prepare(MONTH_LEDGER_SQL);
  const closingStmt = db.prepare('SELECT * FROM month_closing WHERE month = ?');
  const upsertCarryOverStmt = db.prepare(`
    INSERT INTO fund (type, amount, date, source_month, created_by)
    VALUES (0, :amount, :date, :source_month, :created_by)
    ON CONFLICT (date) WHERE type = 0 DO UPDATE SET
      amount       = excluded.amount,
      source_month = excluded.source_month,
      updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    RETURNING id, amount, date`);
  const upsertClosingStmt = db.prepare(`
    INSERT INTO month_closing (month, closing_balance, carry_over_fund_id, confirmed_by)
    VALUES (:month, :closing_balance, :fund_id, :confirmed_by)
    ON CONFLICT (month) DO UPDATE SET
      closing_balance    = excluded.closing_balance,
      carry_over_fund_id = excluded.carry_over_fund_id,
      confirmed_by       = CASE WHEN :refresh THEN excluded.confirmed_by ELSE confirmed_by END,
      confirmed_at       = CASE WHEN :refresh THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE confirmed_at END`);
  const deleteClosingStmt = db.prepare('DELETE FROM month_closing WHERE month = ?');

  function currentMonth() {
    return monthOf(formatLocalDate(clock.now()));
  }

  function getMonth(month) {
    v.month(month);
    const r = monthRange(month);
    const rows = ledgerStmt.all({
      month: r.month,
      prev_month: r.prevMonth,
      start: r.start,
      end: r.end,
      prev_start: r.prevStart,
    });
    const s = rows[0];
    const summary = {
      carryOver: s.carry_over,
      carryOverCount: s.carry_over_count,
      fundIn: s.fund_in,
      fundInCount: s.fund_in_count,
      spent: s.spent,
      purchaseCount: s.purchase_count,
      lineCount: s.line_count,
      balance: s.balance,
      prevBalance: s.prev_balance,
      prevSpent: s.prev_spent,
      prevEntryCount: s.prev_entry_count,
    };
    const status = {
      confirmed: Boolean(s.is_confirmed),
      confirmedAt: s.confirmed_at,
      confirmedBalance: s.confirmed_balance,
      prevConfirmed: Boolean(s.prev_is_confirmed),
      nextCarryOverId: s.next_carry_over_id,
      nextCarryOverAmount: s.next_carry_over_amount,
      // Carried-over amount must equal the previous month's money left.
      carryOverMatchesPrev: s.carry_over_count > 0 ? s.carry_over === s.prev_balance : null,
      prevUnconfirmed: !s.prev_is_confirmed && s.prev_entry_count > 0 && s.carry_over_count === 0,
      // A confirmed month whose carried-over record no longer matches (e.g. after reopening).
      nextCarryOverStale:
        Boolean(s.is_confirmed) && (s.next_carry_over_amount === null || s.next_carry_over_amount !== s.balance),
    };
    const entries = rows
      .filter((row) => row.kind !== null)
      .map((row) => ({
        kind: row.kind,
        id: row.id,
        fundType: row.fund_type,
        date: row.date,
        summary: row.summary,
        amount: row.amount,
        itemCount: row.item_count,
        sourceMonth: row.source_month,
        runningBalance: row.running_balance,
      }));
    return {
      month: r.month,
      prevMonth: r.prevMonth,
      nextMonth: r.nextMonth,
      start: r.start,
      end: r.end,
      currentMonth: currentMonth(),
      summary,
      status,
      entries,
    };
  }

  function isConfirmed(month) {
    return Boolean(closingStmt.get(month));
  }

  /** Throws when the month containing `date` is confirmed (locked). */
  function assertDateOpen(date) {
    const month = monthOf(date);
    if (isConfirmed(month)) throw new AppError('error.ledger.monthLocked', { month });
  }

  /**
   * Confirms a month: writes its money left as the carried-over fund record
   * (type 0) dated on the 1st of the next month, overwriting an existing one.
   * If the next month is already confirmed its balance changed too, so the
   * carry-over chain is refreshed for every following confirmed month.
   */
  const confirmMonth = db.transaction((month) => {
    v.month(month);
    if (month > currentMonth()) throw new AppError('error.ledger.futureMonth', { month });
    const results = [];
    let m = month;
    for (let guard = 0; guard < 1200; guard++) {
      const { summary } = getMonth(m);
      const next = addMonths(m, 1);
      const fund = upsertCarryOverStmt.get({
        amount: summary.balance,
        date: `${next}-01`,
        source_month: m,
        created_by: actorId(),
      });
      upsertClosingStmt.run({
        month: m,
        closing_balance: summary.balance,
        fund_id: fund.id,
        confirmed_by: actorId(),
        refresh: m === month ? 1 : 0,
      });
      results.push({ month: m, closingBalance: summary.balance, carryOver: fund });
      if (!isConfirmed(next)) break;
      m = next;
    }
    return { month, closingBalance: results[0].closingBalance, carryOver: results[0].carryOver, cascaded: results.slice(1) };
  });

  function reopenMonth(month) {
    v.month(month);
    const info = deleteClosingStmt.run(month);
    if (info.changes === 0) throw new AppError('error.ledger.notConfirmed', { month });
    return { month };
  }

  function listClosings() {
    return db.prepare('SELECT * FROM month_closing ORDER BY month').all();
  }

  return { getMonth, confirmMonth, reopenMonth, isConfirmed, assertDateOpen, currentMonth, listClosings };
}

module.exports = { createLedgerService, MONTH_LEDGER_SQL };
