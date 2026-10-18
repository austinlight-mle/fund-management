'use strict';

const crypto = require('crypto');
const { AppError, isUniqueViolation } = require('../errors');
const { hashPassword, verifyPassword } = require('../passwords');
const totp = require('../totp');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
const SECOND_FACTOR_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;

// Session stages:
//   anonymous      – nobody logged in
//   second_factor  – password accepted, waiting for the authenticator code
//   must_change    – logged in with a password that must be changed first
//   authenticated  – full access
const STAGE = Object.freeze({
  ANONYMOUS: 'anonymous',
  SECOND_FACTOR: 'second_factor',
  MUST_CHANGE: 'must_change',
  AUTHENTICATED: 'authenticated',
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = totp.base32Encode(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Single-window session state for the desktop app, kept in the main process. */
class AuthSession {
  constructor(db, { users, clock, issuer = 'Fund Manager' }) {
    this.db = db;
    this.users = users;
    this.clock = clock;
    this.issuer = issuer;
    this.reset();
  }

  reset() {
    this.stage = STAGE.ANONYMOUS;
    this.userId = null;
    this.secondFactorUntil = 0;
    this.pendingTotpSecret = null;
  }

  now() {
    return this.clock.now();
  }

  status() {
    const user = this.userId ? this.users.toPublic(this.db.prepare('SELECT * FROM user WHERE id = ?').get(this.userId)) : null;
    if (this.userId && !user) this.reset();
    return { stage: this.stage, user: this.stage === STAGE.ANONYMOUS ? null : user };
  }

  // ---- login -------------------------------------------------------------

  recordFailure(user) {
    const failed = user.failed_login_count + 1;
    const lockedUntil =
      failed >= MAX_FAILED_ATTEMPTS ? new Date(this.now().getTime() + LOCK_MINUTES * 60000).toISOString() : null;
    this.db
      .prepare('UPDATE user SET failed_login_count = ?, locked_until = ? WHERE id = ?')
      .run(lockedUntil ? 0 : failed, lockedUntil, user.id);
    if (lockedUntil) throw new AppError('error.auth.locked', { minutes: LOCK_MINUTES });
  }

  assertNotLocked(user) {
    if (user.locked_until && new Date(user.locked_until) > this.now()) {
      const minutes = Math.max(1, Math.ceil((new Date(user.locked_until) - this.now()) / 60000));
      throw new AppError('error.auth.locked', { minutes });
    }
  }

  login({ username, password } = {}) {
    this.reset();
    const user = this.users.findByUsername(username);
    if (!user || !user.is_active) throw new AppError('error.auth.invalidCredentials');
    this.assertNotLocked(user);
    if (!verifyPassword(password ?? '', user.password_hash)) {
      this.recordFailure(user);
      throw new AppError('error.auth.invalidCredentials');
    }
    if (user.totp_enabled) {
      this.stage = STAGE.SECOND_FACTOR;
      this.userId = user.id;
      this.secondFactorUntil = this.now().getTime() + SECOND_FACTOR_TTL_MS;
      return this.status();
    }
    return this.finishLogin(user);
  }

  finishLogin(user) {
    this.db
      .prepare('UPDATE user SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(this.now().toISOString(), user.id);
    this.userId = user.id;
    this.stage = user.must_change_password ? STAGE.MUST_CHANGE : STAGE.AUTHENTICATED;
    return this.status();
  }

  /** Accepts a 6-digit authenticator code or one of the recovery codes. */
  verifySecondFactor({ code } = {}) {
    if (this.stage !== STAGE.SECOND_FACTOR || !this.userId) throw new AppError('error.auth.required');
    if (this.now().getTime() > this.secondFactorUntil) {
      this.reset();
      throw new AppError('error.auth.secondFactorExpired');
    }
    const user = this.users.getRow(this.userId);
    this.assertNotLocked(user);
    const trimmed = String(code || '').trim();
    if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
      this.checkTotp(user, trimmed);
    } else if (!this.consumeRecoveryCode(user, trimmed)) {
      this.recordFailure(user);
      throw new AppError('error.auth.invalidCode');
    }
    return this.finishLogin(this.users.getRow(user.id));
  }

  checkTotp(user, code) {
    const step = totp.verifyTotp(user.totp_secret, code, { time: this.now().getTime() });
    if (step === null) {
      this.recordFailure(user);
      throw new AppError('error.auth.invalidCode');
    }
    if (user.totp_last_step !== null && step <= user.totp_last_step) throw new AppError('error.auth.codeAlreadyUsed');
    this.db.prepare('UPDATE user SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  }

  consumeRecoveryCode(user, code) {
    const normalized = normalizeRecovery(code);
    if (normalized.length !== 10 || !user.recovery_codes) return false;
    const hashes = JSON.parse(user.recovery_codes);
    const idx = hashes.indexOf(sha256(normalized));
    if (idx === -1) return false;
    hashes.splice(idx, 1);
    this.db.prepare('UPDATE user SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
    return true;
  }

  logout() {
    this.reset();
    return this.status();
  }

  // ---- guards ------------------------------------------------------------

  requireUser() {
    if (this.stage !== STAGE.AUTHENTICATED || !this.userId) throw new AppError('error.auth.required');
    return this.users.getRow(this.userId);
  }

  requirePasswordAccepted() {
    if ((this.stage !== STAGE.AUTHENTICATED && this.stage !== STAGE.MUST_CHANGE) || !this.userId) {
      throw new AppError('error.auth.required');
    }
    return this.users.getRow(this.userId);
  }

  // ---- credentials -------------------------------------------------------

  /**
   * Changes the password (required) and optionally the username. Used both for
   * the forced first-login change of the default admin/admin and from Settings.
   */
  changeCredentials({ currentPassword, newUsername, newPassword } = {}) {
    const user = this.requirePasswordAccepted();
    if (!verifyPassword(currentPassword ?? '', user.password_hash)) throw new AppError('error.auth.wrongCurrentPassword');
    const password = this.users.validatePassword(newPassword);
    if (verifyPassword(password, user.password_hash)) throw new AppError('error.auth.samePassword');
    const username =
      newUsername === undefined || newUsername === null || String(newUsername).trim() === ''
        ? user.username
        : this.users.validateUsername(newUsername);
    if (username.toLowerCase() === password.toLowerCase()) throw new AppError('error.auth.passwordEqualsUsername');
    try {
      this.db
        .prepare(
          `UPDATE user SET username = ?, password_hash = ?, must_change_password = 0, password_changed_at = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
        )
        .run(username, hashPassword(password), this.now().toISOString(), user.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('error.user.duplicateUsername');
      throw err;
    }
    this.stage = STAGE.AUTHENTICATED;
    return this.status();
  }

  // ---- two-factor (Google Authenticator) ---------------------------------

  beginTotpSetup() {
    const user = this.requireUser();
    if (user.totp_enabled) throw new AppError('error.totp.alreadyEnabled');
    this.pendingTotpSecret = totp.generateSecret();
    return {
      secret: this.pendingTotpSecret,
      uri: totp.otpauthUri({ secret: this.pendingTotpSecret, account: user.username, issuer: this.issuer }),
    };
  }

  confirmTotpSetup({ code } = {}) {
    const user = this.requireUser();
    if (!this.pendingTotpSecret) throw new AppError('error.totp.noSetup');
    const step = totp.verifyTotp(this.pendingTotpSecret, code, { time: this.now().getTime() });
    if (step === null) throw new AppError('error.auth.invalidCode');
    const codes = newRecoveryCodes();
    this.db
      .prepare(
        `UPDATE user SET totp_enabled = 1, totp_secret = ?, totp_last_step = ?, recovery_codes = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
      )
      .run(this.pendingTotpSecret, step, JSON.stringify(codes.map((c) => sha256(normalizeRecovery(c)))), user.id);
    this.pendingTotpSecret = null;
    return { recoveryCodes: codes };
  }

  disableTotp({ password } = {}) {
    const user = this.requireUser();
    if (!verifyPassword(password ?? '', user.password_hash)) throw new AppError('error.auth.wrongCurrentPassword');
    this.db
      .prepare(
        `UPDATE user SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
      )
      .run(user.id);
    return this.status();
  }

  regenerateRecoveryCodes({ password } = {}) {
    const user = this.requireUser();
    if (!user.totp_enabled) throw new AppError('error.totp.notEnabled');
    if (!verifyPassword(password ?? '', user.password_hash)) throw new AppError('error.auth.wrongCurrentPassword');
    const codes = newRecoveryCodes();
    this.db
      .prepare('UPDATE user SET recovery_codes = ? WHERE id = ?')
      .run(JSON.stringify(codes.map((c) => sha256(normalizeRecovery(c)))), user.id);
    return { recoveryCodes: codes };
  }

  recoveryCodesLeft() {
    const user = this.requireUser();
    return user.recovery_codes ? JSON.parse(user.recovery_codes).length : 0;
  }
}

module.exports = { AuthSession, STAGE, MAX_FAILED_ATTEMPTS, LOCK_MINUTES };
