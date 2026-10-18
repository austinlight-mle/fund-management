'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION } = require('./migrations');

function openDatabase(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  backupBeforeUpgrade(db, file);
  migrate(db);
  return db;
}

/** Keeps a consistent copy (fund-manage.db.v1.bak, ...) before an existing database is upgraded. */
function backupBeforeUpgrade(db, file) {
  if (file === ':memory:') return;
  const version = db.pragma('user_version', { simple: true });
  if (version === 0 || version >= SCHEMA_VERSION) return;
  const target = `${file}.v${version}.bak`;
  if (fs.existsSync(target)) return;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

module.exports = { openDatabase };
