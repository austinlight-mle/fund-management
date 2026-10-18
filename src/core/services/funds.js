'use strict';

const { AppError } = require('../errors');
const v = require('../validate');

const FUND_TYPE = Object.freeze({ CARRY_OVER: 0, INPUT: 1 });

function createFundService(db, { ledger, actorId }) {
  const getStmt = db.prepare('SELECT * FROM fund WHERE id = ?');

  function get(id) {
    const row = getStmt.get(v.id(id));
    if (!row) throw new AppError('error.notFound');
    return row;
  }

  /** All fund records of a year (both types) with the confirmation state of their month. */
  function list({ year }) {
    const y = v.integer(year, 'year', { min: 1900, max: 2999 });
    return db
      .prepare(
        `SELECT f.*, mc.month IS NOT NULL AS month_confirmed
         FROM fund AS f
         LEFT JOIN month_closing AS mc ON mc.month = substr(f.date, 1, 7)
         WHERE f.date >= ? AND f.date < ?
         ORDER BY f.date, f.type, f.id`
      )
      .all(`${y}-01-01`, `${y + 1}-01-01`);
  }

  function normalize(input) {
    return {
      amount: v.money(input.amount, 'amount', { min: 1 }),
      date: v.date(input.date),
      memo: v.optionalText(input.memo, 'memo', { max: 200 }),
    };
  }

  function editable(row) {
    if (row.type !== FUND_TYPE.INPUT) throw new AppError('error.fund.carryOverReadOnly');
    ledger.assertDateOpen(row.date);
    return row;
  }

  function create(input) {
    const data = normalize(input);
    ledger.assertDateOpen(data.date);
    const info = db
      .prepare('INSERT INTO fund (type, amount, date, memo, created_by) VALUES (1, @amount, @date, @memo, @created_by)')
      .run({ ...data, created_by: actorId() });
    return get(info.lastInsertRowid);
  }

  function update(id, input) {
    const existing = editable(get(id));
    const data = normalize({ ...existing, ...input });
    ledger.assertDateOpen(data.date);
    db.prepare(
      `UPDATE fund SET amount = @amount, date = @date, memo = @memo,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
    ).run({ ...data, id: existing.id });
    return get(existing.id);
  }

  function remove(id) {
    const existing = editable(get(id));
    db.prepare('DELETE FROM fund WHERE id = ?').run(existing.id);
    return { id: existing.id };
  }

  return { list, get, create, update, remove };
}

module.exports = { createFundService, FUND_TYPE };
