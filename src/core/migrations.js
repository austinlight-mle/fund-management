'use strict';

const { hashPassword } = require('./passwords');

// Timestamps are ISO-8601 UTC strings; calendar dates are local 'YYYY-MM-DD'.
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
const DATE_CHECK = (col) => `${col} GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'`;

const SCHEMA_V1 = `
CREATE TABLE app_setting (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE user (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash         TEXT NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  totp_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_secret           TEXT,                -- base32 secret for Google Authenticator
  totp_last_step        INTEGER,             -- last accepted time step (replay protection)
  recovery_codes        TEXT,                -- JSON array of SHA-256 hashes of unused codes
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  password_changed_at   TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at            TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE category (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  parent_id    INTEGER REFERENCES category(id) ON DELETE RESTRICT,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW},
  CHECK (parent_id IS NULL OR parent_id <> id)
);
-- Sibling names are unique (case-insensitive); the same name may exist under different parents.
CREATE UNIQUE INDEX ux_category_sibling_name ON category (IFNULL(parent_id, 0), name COLLATE NOCASE);
CREATE INDEX ix_category_parent ON category (parent_id);

CREATE TABLE product (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category_id  INTEGER REFERENCES category(id) ON DELETE SET NULL,  -- NULL = uncategorized
  memo         TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),  -- inactive = hidden from suggestions
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX ix_product_category ON product (category_id);

-- type 0 = carried over from the previous month (system generated on month confirmation)
-- type 1 = new fund input
-- amount is INTEGER minor units (value x 100)
CREATE TABLE fund (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          INTEGER NOT NULL CHECK (type IN (0, 1)),
  amount        INTEGER NOT NULL,
  date          TEXT NOT NULL CHECK (${DATE_CHECK('date')}),
  memo          TEXT,
  source_month  TEXT,               -- type 0 only: the 'YYYY-MM' month whose balance was carried over
  created_by    INTEGER REFERENCES user(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_at    TEXT NOT NULL DEFAULT ${NOW},
  CHECK (type = 1 OR substr(date, 9, 2) = '01'),
  CHECK (type = 0 OR amount > 0)
);
-- At most one carried-over record per month (always dated on the 1st).
CREATE UNIQUE INDEX ux_fund_carry_over ON fund (date) WHERE type = 0;
CREATE INDEX ix_fund_date ON fund (date, type);

CREATE TABLE purchase (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  summary     TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL CHECK (${DATE_CHECK('date')}),
  memo        TEXT,
  created_by  INTEGER REFERENCES user(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX ix_purchase_date ON purchase (date);

-- price is the unit price in INTEGER minor units; line total = price * count
CREATE TABLE purchase_list (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  price        INTEGER NOT NULL CHECK (price >= 0),
  count        INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  memo         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX ix_purchase_list_purchase ON purchase_list (purchase_id, sort_order);
CREATE INDEX ix_purchase_list_product ON purchase_list (product_id);

-- A row here means the month is confirmed (locked). Confirming writes the
-- closing balance into a type-0 fund record dated on the 1st of the next month.
CREATE TABLE month_closing (
  month               TEXT PRIMARY KEY CHECK (month GLOB '[12][0-9][0-9][0-9]-[01][0-9]'),
  closing_balance     INTEGER NOT NULL,
  carry_over_fund_id  INTEGER REFERENCES fund(id) ON DELETE SET NULL,
  confirmed_by        INTEGER REFERENCES user(id) ON DELETE SET NULL,
  confirmed_at        TEXT NOT NULL DEFAULT ${NOW}
);

-- User edits to the built-in dictionaries (src/i18n/*.json).
CREATE TABLE translation_override (
  lang        TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (lang, key)
);
`;

// v2: products get a "standard" (specification such as 1L / 500g / size M).
// The same name may exist once per standard, so uniqueness moves from name to
// (name, standard). SQLite cannot drop a column constraint, so the table is
// rebuilt; ids are kept, so purchase_list references stay valid.
const PRODUCT_V2 = `
CREATE TABLE product_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL COLLATE NOCASE,
  standard     TEXT NOT NULL DEFAULT '' COLLATE NOCASE,  -- '' = no standard
  category_id  INTEGER REFERENCES category(id) ON DELETE SET NULL,  -- NULL = uncategorized
  memo         TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),  -- inactive = hidden from suggestions
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
);
INSERT INTO product_v2 (id, name, standard, category_id, memo, is_active, created_at, updated_at)
  SELECT id, name, '', category_id, memo, is_active, created_at, updated_at FROM product;
DROP TABLE product;
ALTER TABLE product_v2 RENAME TO product;
CREATE UNIQUE INDEX ux_product_name_standard ON product (name, standard);
CREATE INDEX ix_product_category ON product (category_id);
`;

const MIGRATIONS = [
  function v1(db) {
    db.exec(SCHEMA_V1);
    db.prepare(
      `INSERT INTO user (username, password_hash, must_change_password) VALUES ('admin', ?, 1)`
    ).run(hashPassword('admin'));
  },
  function v2(db) {
    // Keep the AUTOINCREMENT counter so ids of deleted products are never reused.
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'product'").pluck().get() ?? 0;
    db.exec(PRODUCT_V2);
    db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'product', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'product')").run();
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'product'").run(seq);
  },
];

/**
 * Applies pending migrations, each in its own transaction. Foreign keys are
 * switched off while migrating (required for table rebuilds) and checked
 * before every commit.
 */
function migrate(db, { target = MIGRATIONS.length } = {}) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= target) return;
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < target; v++) {
      db.transaction(() => {
        MIGRATIONS[v](db);
        const problems = db.pragma('foreign_key_check');
        if (problems.length) throw new Error(`Migration ${v + 1} left ${problems.length} broken foreign keys`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

module.exports = { migrate, SCHEMA_VERSION: MIGRATIONS.length };
