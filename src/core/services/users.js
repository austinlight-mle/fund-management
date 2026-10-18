'use strict';

const { AppError, isUniqueViolation } = require('../errors');
const v = require('../validate');
const { hashPassword } = require('../passwords');

const USERNAME_RE = /^[A-Za-z0-9._@-]{3,32}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;

const PUBLIC_COLUMNS = `id, username, must_change_password, totp_enabled, failed_login_count, locked_until,
  last_login_at, password_changed_at, is_active, created_at, updated_at`;

function validateUsername(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!USERNAME_RE.test(name)) throw new AppError('error.user.invalidUsername');
  return name;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw new AppError('error.user.weakPassword', { min: MIN_PASSWORD });
  }
  return value;
}

function createUserService(db) {
  const getStmt = db.prepare('SELECT * FROM user WHERE id = ?');
  const byNameStmt = db.prepare('SELECT * FROM user WHERE username = ?');

  function getRow(id) {
    const row = getStmt.get(v.id(id));
    if (!row) throw new AppError('error.notFound');
    return row;
  }

  function findByUsername(username) {
    return byNameStmt.get(String(username || '').trim()) || null;
  }

  function toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      must_change_password: row.must_change_password,
      totp_enabled: row.totp_enabled,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
    };
  }

  function list() {
    return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user ORDER BY username COLLATE NOCASE`).all();
  }

  function create({ username, password }) {
    const name = validateUsername(username);
    const pw = validatePassword(password);
    try {
      const info = db
        .prepare('INSERT INTO user (username, password_hash, must_change_password) VALUES (?, ?, 1)')
        .run(name, hashPassword(pw));
      return toPublic(getRow(info.lastInsertRowid));
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('error.user.duplicateUsername');
      throw err;
    }
  }

  function remove(id, currentUserId) {
    const row = getRow(id);
    if (row.id === currentUserId) throw new AppError('error.user.cannotDeleteSelf');
    db.prepare('DELETE FROM user WHERE id = ?').run(row.id);
    return { id: row.id };
  }

  /** Sets a temporary password; the user must change it at next login. */
  function resetPassword(id, password) {
    const row = getRow(id);
    const pw = validatePassword(password);
    db.prepare(
      `UPDATE user SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(hashPassword(pw), row.id);
    return toPublic(getRow(row.id));
  }

  return { getRow, findByUsername, toPublic, list, create, remove, resetPassword, validateUsername, validatePassword };
}

module.exports = { createUserService, MIN_PASSWORD };
