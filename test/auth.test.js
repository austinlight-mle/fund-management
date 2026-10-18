'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, loginAdmin, throwsCode } = require('./helpers');
const totp = require('../src/core/totp');
const { verifyPassword } = require('../src/core/passwords');

/** A 6-digit code that is not valid anywhere in the +/- 1 step window. */
function invalidCode(secret, time) {
  const valid = new Set([-1, 0, 1].map((d) => totp.totp(secret, { time: time + d * 30000 })));
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c));
}

test('a default admin/admin user exists and must change the password', () => {
  const s = setup();
  const admin = s.users.findByUsername('admin');
  assert.ok(admin);
  assert.equal(admin.must_change_password, 1);
  assert.ok(admin.password_hash.startsWith('scrypt$'));
  assert.notEqual(admin.password_hash, 'admin');
  assert.ok(verifyPassword('admin', admin.password_hash));

  const status = s.auth.login({ username: 'admin', password: 'admin' });
  assert.equal(status.stage, 'must_change');
  // Nothing else is allowed until the password is changed.
  throwsCode(assert, () => s.auth.requireUser(), 'error.auth.required');
  throwsCode(assert, () => s.auth.beginTotpSetup(), 'error.auth.required');
});

test('forced credential change validates input and unlocks the app', () => {
  const s = setup();
  s.auth.login({ username: 'admin', password: 'admin' });
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'nope', newPassword: 'secret123' }), 'error.auth.wrongCurrentPassword');
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'admin', newPassword: 'admin' }), 'error.user.weakPassword');
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'admin', newPassword: '12345' }), 'error.user.weakPassword');
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'admin', newUsername: 'bad name', newPassword: 'secret123' }), 'error.user.invalidUsername');
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'admin', newUsername: 'secret123', newPassword: 'secret123' }), 'error.auth.passwordEqualsUsername');

  const status = s.auth.changeCredentials({ currentPassword: 'admin', newUsername: 'austin', newPassword: 'secret123' });
  assert.equal(status.stage, 'authenticated');
  assert.equal(status.user.username, 'austin');
  assert.equal(status.user.must_change_password, 0);
  assert.ok(s.auth.requireUser());

  s.auth.logout();
  throwsCode(assert, () => s.auth.login({ username: 'admin', password: 'admin' }), 'error.auth.invalidCredentials');
  throwsCode(assert, () => s.auth.login({ username: 'austin', password: 'admin' }), 'error.auth.invalidCredentials');
  assert.equal(s.auth.login({ username: 'AUSTIN', password: 'secret123' }).stage, 'authenticated'); // usernames are case-insensitive
  throwsCode(assert, () => s.auth.changeCredentials({ currentPassword: 'secret123', newPassword: 'secret123' }), 'error.auth.samePassword');
});

test('five wrong passwords lock the account for five minutes', () => {
  const s = setup();
  loginAdmin(s, 'secret123');
  s.auth.logout();
  for (let i = 1; i <= 4; i++) {
    throwsCode(assert, () => s.auth.login({ username: 'admin', password: 'wrong' }), 'error.auth.invalidCredentials');
  }
  throwsCode(assert, () => s.auth.login({ username: 'admin', password: 'wrong' }), 'error.auth.locked');
  throwsCode(assert, () => s.auth.login({ username: 'admin', password: 'secret123' }), 'error.auth.locked');
  s.clock.advance(4 * 60 * 1000);
  throwsCode(assert, () => s.auth.login({ username: 'admin', password: 'secret123' }), 'error.auth.locked');
  s.clock.advance(61 * 1000);
  assert.equal(s.auth.login({ username: 'admin', password: 'secret123' }).stage, 'authenticated');
  assert.equal(s.users.findByUsername('admin').failed_login_count, 0);
  throwsCode(assert, () => s.auth.login({ username: 'ghost', password: 'x' }), 'error.auth.invalidCredentials');
});

test('Google Authenticator 2FA: setup, login, replay protection, recovery codes, disable', () => {
  const s = setup();
  loginAdmin(s, 'secret123');
  const now = () => s.clock.now().getTime();

  throwsCode(assert, () => s.auth.confirmTotpSetup({ code: '000000' }), 'error.totp.noSetup');
  const setupInfo = s.auth.beginTotpSetup();
  assert.match(setupInfo.uri, /^otpauth:\/\/totp\//);
  throwsCode(assert, () => s.auth.confirmTotpSetup({ code: '000000' }), 'error.auth.invalidCode');
  const { recoveryCodes } = s.auth.confirmTotpSetup({ code: totp.totp(setupInfo.secret, { time: now() }) });
  assert.equal(recoveryCodes.length, 8);
  assert.ok(recoveryCodes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)));
  assert.equal(new Set(recoveryCodes).size, 8);
  assert.equal(s.auth.status().user.totp_enabled, 1);
  throwsCode(assert, () => s.auth.beginTotpSetup(), 'error.totp.alreadyEnabled');

  // Password alone is no longer enough.
  s.auth.logout();
  assert.equal(s.auth.login({ username: 'admin', password: 'secret123' }).stage, 'second_factor');
  throwsCode(assert, () => s.auth.requireUser(), 'error.auth.required');
  // The code used during setup cannot be replayed.
  throwsCode(assert, () => s.auth.verifySecondFactor({ code: totp.totp(setupInfo.secret, { time: now() }) }), 'error.auth.codeAlreadyUsed');
  throwsCode(assert, () => s.auth.verifySecondFactor({ code: invalidCode(setupInfo.secret, now()) }), 'error.auth.invalidCode');
  s.clock.advance(30000);
  const code = totp.totp(setupInfo.secret, { time: now() });
  assert.equal(s.auth.verifySecondFactor({ code }).stage, 'authenticated');

  // Same code again after logging out: rejected (replay).
  s.auth.logout();
  s.auth.login({ username: 'admin', password: 'secret123' });
  throwsCode(assert, () => s.auth.verifySecondFactor({ code }), 'error.auth.codeAlreadyUsed');

  // A recovery code works exactly once (format-insensitive).
  assert.equal(s.auth.verifySecondFactor({ code: recoveryCodes[0].toUpperCase().replace('-', ' ') }).stage, 'authenticated');
  assert.equal(s.auth.recoveryCodesLeft(), 7);
  s.auth.logout();
  s.auth.login({ username: 'admin', password: 'secret123' });
  throwsCode(assert, () => s.auth.verifySecondFactor({ code: recoveryCodes[0] }), 'error.auth.invalidCode');
  assert.equal(s.auth.verifySecondFactor({ code: recoveryCodes[1] }).stage, 'authenticated');

  // The second step expires after five minutes.
  s.auth.logout();
  s.auth.login({ username: 'admin', password: 'secret123' });
  s.clock.advance(5 * 60 * 1000 + 1000);
  throwsCode(assert, () => s.auth.verifySecondFactor({ code: totp.totp(setupInfo.secret, { time: now() }) }), 'error.auth.secondFactorExpired');
  assert.equal(s.auth.status().stage, 'anonymous');

  // Regenerate and disable require the password.
  s.auth.login({ username: 'admin', password: 'secret123' });
  s.auth.verifySecondFactor({ code: recoveryCodes[2] });
  throwsCode(assert, () => s.auth.regenerateRecoveryCodes({ password: 'bad' }), 'error.auth.wrongCurrentPassword');
  const fresh = s.auth.regenerateRecoveryCodes({ password: 'secret123' }).recoveryCodes;
  assert.equal(s.auth.recoveryCodesLeft(), 8);
  assert.ok(!fresh.includes(recoveryCodes[3]));
  throwsCode(assert, () => s.auth.disableTotp({ password: 'bad' }), 'error.auth.wrongCurrentPassword');
  s.auth.disableTotp({ password: 'secret123' });
  const row = s.users.findByUsername('admin');
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);
  s.auth.logout();
  assert.equal(s.auth.login({ username: 'admin', password: 'secret123' }).stage, 'authenticated');
});

test('wrong 2FA codes count towards the lockout', () => {
  const s = setup();
  loginAdmin(s, 'secret123');
  const info = s.auth.beginTotpSetup();
  s.auth.confirmTotpSetup({ code: totp.totp(info.secret, { time: s.clock.now().getTime() }) });
  s.auth.logout();
  s.auth.login({ username: 'admin', password: 'secret123' });
  const wrong = invalidCode(info.secret, s.clock.now().getTime());
  for (let i = 0; i < 4; i++) throwsCode(assert, () => s.auth.verifySecondFactor({ code: wrong }), 'error.auth.invalidCode');
  throwsCode(assert, () => s.auth.verifySecondFactor({ code: wrong }), 'error.auth.locked');
});

test('user management: create, duplicate, reset, delete', () => {
  const s = setup();
  const me = loginAdmin(s, 'secret123').user;
  const u = s.users.create({ username: 'partner', password: 'temp1234' });
  assert.equal(u.must_change_password, 1);
  throwsCode(assert, () => s.users.create({ username: 'PARTNER', password: 'temp1234' }), 'error.user.duplicateUsername');
  throwsCode(assert, () => s.users.create({ username: 'x', password: 'temp1234' }), 'error.user.invalidUsername');
  throwsCode(assert, () => s.users.remove(me.id, me.id), 'error.user.cannotDeleteSelf');
  assert.equal(s.users.list().length, 2);

  s.auth.logout();
  assert.equal(s.auth.login({ username: 'partner', password: 'temp1234' }).stage, 'must_change');
  s.auth.changeCredentials({ currentPassword: 'temp1234', newPassword: 'partner-pw' });
  s.auth.logout();
  s.auth.login({ username: 'admin', password: 'secret123' });
  s.users.resetPassword(u.id, 'reset-pw');
  assert.equal(s.users.findByUsername('partner').must_change_password, 1);
  s.users.remove(u.id, me.id);
  assert.equal(s.users.list().length, 1);
});
