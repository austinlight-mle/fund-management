'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, loginAdmin, prng, pad2, throwsCode } = require('./helpers');
const { addMonths } = require('../src/core/dates');
const { MONTHS, sum, seed, expectedMonth } = require('./fixtures');
const { createLedgerService } = require('../src/core/services/ledger');

function assertMonthMatches(actual, expected, label) {
  assert.equal(actual.summary.fundIn, expected.fundIn, `${label}: funds in`);
  assert.equal(actual.summary.spent, expected.spent, `${label}: spent`);
  assert.equal(actual.summary.carryOver, expected.carryOver, `${label}: carried over`);
  assert.equal(actual.summary.balance, expected.balance, `${label}: money left`);
  assert.equal(actual.summary.purchaseCount, expected.purchaseCount, `${label}: purchase count`);
  assert.equal(actual.entries.length, expected.entries.length, `${label}: entry count`);
  actual.entries.forEach((e, i) => {
    const x = expected.entries[i];
    const where = `${label} entry #${i + 1}`;
    assert.equal(e.kind, x.kind, `${where} kind`);
    assert.equal(e.fundType, x.fundType, `${where} fund type`);
    if (x.id !== null) assert.equal(e.id, x.id, `${where} id`);
    assert.equal(e.date, x.date, `${where} date`);
    assert.equal(e.amount, x.amount, `${where} amount`);
    assert.equal(e.runningBalance, x.runningBalance, `${where} running balance`);
  });
  if (actual.entries.length) {
    assert.equal(actual.entries[actual.entries.length - 1].runningBalance, actual.summary.balance, `${label}: last running balance = money left`);
  }
}

test('month ledger numbers match an independent calculation (6 months of random data)', () => {
  const s = setup();
  loginAdmin(s);
  const { data } = seed(s);
  assert.ok(data.purchases.length >= 36, 'enough purchases seeded');
  assert.ok(sum(data.purchases, (p) => p.items.length) >= 100, 'enough purchase items seeded');

  // Nothing confirmed yet: every month stands alone (no carry-over).
  let prev = null;
  for (const month of MONTHS) {
    const actual = s.ledger.getMonth(month);
    const expected = expectedMonth(data, month);
    assertMonthMatches(actual, expected, month);
    assert.equal(actual.summary.prevBalance, prev ? prev.balance : 0, `${month}: previous month balance`);
    assert.equal(actual.status.prevUnconfirmed, Boolean(prev), `${month}: previous month unconfirmed flag`);
    assert.equal(actual.status.carryOverMatchesPrev, null);
    prev = expected;
  }
});

test('confirming months chains the carried-over amount and stays consistent with all-time totals', () => {
  const s = setup();
  loginAdmin(s);
  const { data } = seed(s);

  let carry = null;
  for (const month of MONTHS) {
    const expected = expectedMonth(data, month, carry);
    assertMonthMatches(s.ledger.getMonth(month), expected, `${month} before confirm`);

    const result = s.ledger.confirmMonth(month);
    assert.equal(result.closingBalance, expected.balance, `${month}: closing balance`);
    assert.deepEqual(result.cascaded, []);

    const next = addMonths(month, 1);
    const carryRows = s.db.prepare('SELECT * FROM fund WHERE type = 0 AND date = ?').all(`${next}-01`);
    assert.equal(carryRows.length, 1, `${next}: exactly one carried-over record`);
    assert.equal(carryRows[0].amount, expected.balance, `${next}: carried-over amount`);
    assert.equal(carryRows[0].source_month, month);

    const confirmed = s.ledger.getMonth(month);
    assert.equal(confirmed.status.confirmed, true);
    assert.equal(confirmed.status.confirmedBalance, expected.balance);
    assert.equal(confirmed.status.nextCarryOverAmount, expected.balance);
    assert.equal(confirmed.status.nextCarryOverStale, false);

    const nextView = s.ledger.getMonth(next);
    assert.equal(nextView.summary.carryOver, expected.balance, `${next}: carried over shown`);
    assert.equal(nextView.summary.prevBalance, expected.balance, `${next}: previous month money left`);
    assert.equal(nextView.status.carryOverMatchesPrev, true);
    assert.equal(nextView.status.prevConfirmed, true);
    assert.equal(nextView.entries[0].fundType, 0, `${next}: carried-over row first`);
    assert.equal(nextView.entries[0].date, `${next}-01`);
    carry = expected.balance;
  }

  // With every month confirmed in order, July's carry-over equals all inputs minus all spending.
  const allIn = sum(data.funds, (f) => f.amount);
  const allSpent = sum(data.purchases, (p) => p.cost);
  const july = s.ledger.getMonth('2026-07');
  assert.equal(july.summary.carryOver, allIn - allSpent);
  assert.equal(july.summary.balance, allIn - allSpent);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM fund WHERE type = 0').pluck().get(), MONTHS.length);
});

test('re-confirming overwrites the carried-over record and refreshes later confirmed months', () => {
  const s = setup();
  loginAdmin(s);
  const { data } = seed(s);
  MONTHS.forEach((m) => s.ledger.confirmMonth(m));
  const julyBefore = s.ledger.getMonth('2026-07').summary.carryOver;
  const aprilClosingBefore = s.ledger.listClosings().find((c) => c.month === '2026-04');

  // Reopen March and add a purchase worth 123,450.
  s.ledger.reopenMonth('2026-03');
  assert.equal(s.ledger.getMonth('2026-03').status.confirmed, false);
  const extra = s.purchases.create({ date: '2026-03-31', summary: 'Late receipt' });
  s.purchases.saveItems(extra.id, [
    { product_name: 'Coffee', price: 4500 * 100, count: 3 },
    { product_name: 'Brand new product', price: 109950 * 100, count: 1 },
  ]);
  data.purchases.push({ id: extra.id, date: '2026-03-31', items: [], cost: 123450 * 100 });

  // April now shows a mismatch until March is confirmed again.
  const aprilView = s.ledger.getMonth('2026-04');
  assert.equal(aprilView.status.carryOverMatchesPrev, false);
  assert.equal(aprilView.summary.prevBalance, aprilView.summary.carryOver - 123450 * 100);

  const result = s.ledger.confirmMonth('2026-03');
  assert.deepEqual(result.cascaded.map((c) => c.month), ['2026-04', '2026-05', '2026-06']);
  assert.equal(s.ledger.getMonth('2026-07').summary.carryOver, julyBefore - 123450 * 100);

  // Still exactly one carried-over record per month, chain consistent everywhere.
  const counts = s.db.prepare('SELECT date, COUNT(*) AS n FROM fund WHERE type = 0 GROUP BY date').all();
  assert.equal(counts.length, MONTHS.length);
  assert.ok(counts.every((c) => c.n === 1));
  let carry = null;
  for (const month of MONTHS) {
    const expected = expectedMonth(data, month, carry);
    const view = s.ledger.getMonth(month);
    assert.equal(view.summary.balance, expected.balance, `${month}: balance after re-confirm`);
    assert.equal(view.status.nextCarryOverAmount, expected.balance, `${month}: next carry-over after re-confirm`);
    if (carry !== null) assert.equal(view.status.carryOverMatchesPrev, true, `${month}: matches previous month`);
    carry = expected.balance;
  }
  // Cascaded months keep their original confirmation time; only the balance changed.
  const aprilClosingAfter = s.ledger.listClosings().find((c) => c.month === '2026-04');
  assert.equal(aprilClosingAfter.confirmed_at, aprilClosingBefore.confirmed_at);
  assert.equal(aprilClosingAfter.closing_balance, aprilClosingBefore.closing_balance - 123450 * 100);
});

test('confirmed months are locked against every change that affects their numbers', () => {
  const s = setup();
  loginAdmin(s);
  const fund = s.funds.create({ amount: 100000, date: '2026-02-03' });
  const feb = s.purchases.create({ date: '2026-02-10', summary: 'Feb' });
  s.purchases.saveItems(feb.id, [{ product_name: 'Milk', price: 250000, count: 1 }]);
  const mar = s.purchases.create({ date: '2026-03-10', summary: 'Mar' });
  s.ledger.confirmMonth('2026-02');

  const locked = 'error.ledger.monthLocked';
  throwsCode(assert, () => s.purchases.create({ date: '2026-02-20', summary: 'x' }), locked);
  throwsCode(assert, () => s.purchases.update(feb.id, { summary: 'changed' }), locked);
  throwsCode(assert, () => s.purchases.update(feb.id, { date: '2026-03-01' }), locked);
  throwsCode(assert, () => s.purchases.update(mar.id, { date: '2026-02-28' }), locked); // moving into a locked month
  throwsCode(assert, () => s.purchases.remove(feb.id), locked);
  throwsCode(assert, () => s.purchases.saveItems(feb.id, []), locked);
  throwsCode(assert, () => s.funds.create({ amount: 100, date: '2026-02-01' }), locked);
  throwsCode(assert, () => s.funds.update(fund.id, { amount: 1 }), locked);
  throwsCode(assert, () => s.funds.remove(fund.id), locked);

  // Carried-over records are never editable by hand.
  const carry = s.db.prepare('SELECT * FROM fund WHERE type = 0').get();
  throwsCode(assert, () => s.funds.update(carry.id, { amount: 1 }), 'error.fund.carryOverReadOnly');
  throwsCode(assert, () => s.funds.remove(carry.id), 'error.fund.carryOverReadOnly');

  // March is open and still editable; reopening February unlocks it.
  s.purchases.update(mar.id, { summary: 'March edited' });
  s.ledger.reopenMonth('2026-02');
  s.purchases.update(feb.id, { summary: 'changed' });
  throwsCode(assert, () => s.ledger.reopenMonth('2026-02'), 'error.ledger.notConfirmed');
});

test('future months cannot be confirmed; a stale carry-over is flagged on the confirmed month', () => {
  const s = setup({ now: '2026-10-18T09:00:00' });
  loginAdmin(s);
  throwsCode(assert, () => s.ledger.confirmMonth('2026-11'), 'error.ledger.futureMonth');
  s.funds.create({ amount: 500000, date: '2026-10-02' });
  assert.equal(s.ledger.confirmMonth('2026-10').closingBalance, 500000); // current month is allowed

  s.funds.create({ amount: 700000, date: '2026-09-02' });
  s.ledger.confirmMonth('2026-09'); // cascades into the confirmed October
  const oct = s.ledger.getMonth('2026-10');
  assert.equal(oct.summary.carryOver, 700000);
  assert.equal(oct.summary.balance, 1200000);
  assert.equal(oct.status.nextCarryOverAmount, 1200000);

  // Manually corrupt November's carry-over to simulate drift: October flags it as stale.
  s.db.prepare("UPDATE fund SET amount = 1 WHERE type = 0 AND date = '2026-11-01'").run();
  assert.equal(s.ledger.getMonth('2026-10').status.nextCarryOverStale, true);
  s.ledger.confirmMonth('2026-10');
  assert.equal(s.ledger.getMonth('2026-10').status.nextCarryOverStale, false);
});

test('negative money left is carried over as a negative amount', () => {
  const s = setup();
  loginAdmin(s);
  s.funds.create({ amount: 10000 * 100, date: '2026-05-01' });
  const p = s.purchases.create({ date: '2026-05-02', summary: 'Overspend' });
  s.purchases.saveItems(p.id, [{ product_name: 'TV', price: 35000 * 100, count: 1 }]);
  const may = s.ledger.getMonth('2026-05');
  assert.equal(may.summary.balance, -25000 * 100);
  assert.deepEqual(may.entries.map((e) => e.runningBalance), [10000 * 100, -25000 * 100]);
  s.ledger.confirmMonth('2026-05');
  const june = s.ledger.getMonth('2026-06');
  assert.equal(june.summary.carryOver, -25000 * 100);
  assert.equal(june.entries[0].amount, -25000 * 100);
});

test('an empty month still returns a complete summary row', () => {
  const s = setup();
  const view = s.ledger.getMonth('2030-01');
  assert.deepEqual(view.entries, []);
  assert.equal(view.summary.balance, 0);
  assert.equal(view.summary.carryOver, 0);
  assert.equal(view.status.confirmed, false);
  assert.equal(view.status.prevUnconfirmed, false);
  throwsCode(assert, () => s.ledger.getMonth('2030-13'), 'error.validation.month');
});

test('the month ledger is produced by exactly one SQL query', () => {
  const s = setup();
  loginAdmin(s);
  seed(s, { months: ['2026-02', '2026-03'] });
  s.ledger.confirmMonth('2026-02');

  let executions = 0;
  const countingDb = new Proxy(s.db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(st, p) {
              const value = st[p];
              if (['all', 'get', 'run', 'iterate'].includes(p)) {
                return (...args) => {
                  executions += 1;
                  return value.apply(st, args);
                };
              }
              return typeof value === 'function' ? value.bind(st) : value;
            },
          });
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const ledger = createLedgerService(countingDb, { clock: s.clock, actorId: () => null });
  executions = 0;
  const view = ledger.getMonth('2026-03');
  assert.equal(executions, 1, 'one statement execution for entries + running balance + summary + status');
  assert.ok(view.entries.length > 0);
  assert.equal(view.summary.carryOver, s.ledger.getMonth('2026-02').summary.balance);
});

test('database constraints back up the carried-over rules', () => {
  const s = setup();
  s.db.prepare("INSERT INTO fund (type, amount, date) VALUES (0, 100, '2026-04-01')").run();
  assert.throws(() => s.db.prepare("INSERT INTO fund (type, amount, date) VALUES (0, 200, '2026-04-01')").run(), /UNIQUE/);
  assert.throws(() => s.db.prepare("INSERT INTO fund (type, amount, date) VALUES (0, 200, '2026-04-02')").run(), /CHECK/);
  assert.throws(() => s.db.prepare("INSERT INTO fund (type, amount, date) VALUES (1, 0, '2026-04-02')").run(), /CHECK/);
  assert.throws(() => s.db.prepare("INSERT INTO fund (type, amount, date) VALUES (2, 10, '2026-04-02')").run(), /CHECK/);
});

test('ledger query stays fast with a large history', () => {
  const s = setup();
  const insertP = s.db.prepare('INSERT INTO purchase (summary, date) VALUES (?, ?)');
  const insertI = s.db.prepare('INSERT INTO purchase_list (purchase_id, product_id, price, count) VALUES (?, ?, ?, ?)');
  const product = s.products.create({ name: 'Bulk' });
  const r = prng(7);
  let expectedSpent = 0;
  s.db.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const month = `2025-${pad2((i % 12) + 1)}`;
      const date = `${month}-${pad2(r.int(1, 28))}`;
      const pid = insertP.run(`P${i}`, date).lastInsertRowid;
      for (let k = 0; k < 5; k++) {
        const price = r.int(1, 999) * 100;
        insertI.run(pid, product.id, price, 2);
        if (month === '2025-07') expectedSpent += price * 2;
      }
    }
  })();
  const started = process.hrtime.bigint();
  const view = s.ledger.getMonth('2025-07');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(view.summary.purchaseCount, 500);
  assert.equal(view.summary.spent, expectedSpent);
  assert.ok(ms < 500, `ledger query took ${ms.toFixed(1)} ms`);
});
