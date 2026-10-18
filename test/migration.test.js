'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION } = require('../src/core/migrations');
const { openDatabase } = require('../src/core/db');

/** A database at schema v1 (before product standards) with some history. */
function v1Database(file = ':memory:') {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  migrate(db, { target: 1 });
  db.exec(`
    INSERT INTO category (id, name) VALUES (1, 'Food');
    INSERT INTO product (id, name, category_id) VALUES (1, 'Milk', 1), (2, 'Bread', NULL), (5, 'Eggs', 1);
    DELETE FROM product WHERE id = 5;  -- sequence stays at 5
    INSERT INTO purchase (id, summary, date) VALUES (1, 'Mart', '2026-09-01');
    INSERT INTO purchase_list (purchase_id, product_id, price, count) VALUES (1, 1, 250000, 2), (1, 2, 300000, 1);
  `);
  return db;
}

test('v2 migration adds product standards and keeps every product and purchase link', () => {
  const db = v1Database();
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const products = db.prepare('SELECT id, name, standard, category_id FROM product ORDER BY id').all();
  assert.deepEqual(products, [
    { id: 1, name: 'Milk', standard: '', category_id: 1 },
    { id: 2, name: 'Bread', standard: '', category_id: null },
  ]);
  const lines = db.prepare('SELECT pl.product_id, p.name FROM purchase_list pl JOIN product p ON p.id = pl.product_id ORDER BY pl.id').all();
  assert.deepEqual(lines.map((l) => l.name), ['Milk', 'Bread']);

  // Uniqueness is now per (name, standard), case-insensitive.
  db.prepare("INSERT INTO product (name, standard) VALUES ('Milk', '1L')").run();
  assert.throws(() => db.prepare("INSERT INTO product (name, standard) VALUES ('MILK', '1l')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO product (name) VALUES ('milk')").run(), /UNIQUE/);
  // AUTOINCREMENT history survives the table rebuild: ids are never reused.
  assert.ok(db.prepare("SELECT id FROM product WHERE standard = '1L'").pluck().get() > 5);
  // Foreign keys still protect purchase history.
  assert.throws(() => db.prepare('DELETE FROM product WHERE id = 1').run(), /FOREIGN KEY/);
  db.close();
});

test('opening an older database file backs it up before upgrading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-manage-migrate-'));
  const file = path.join(dir, 'fund-manage.db');
  v1Database(file).close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  db.close();

  const backup = `${file}.v1.bak`;
  assert.ok(fs.existsSync(backup), 'backup written');
  const old = new Database(backup, { readonly: true });
  assert.equal(old.pragma('user_version', { simple: true }), 1);
  assert.equal(old.prepare('SELECT COUNT(*) FROM purchase_list').pluck().get(), 2);
  old.close();

  // Opening an up-to-date database does not write another backup.
  openDatabase(file).close();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.bak')), ['fund-manage.db.v1.bak']);
  fs.rmSync(dir, { recursive: true, force: true });
});
