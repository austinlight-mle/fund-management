'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/core/totp');

// RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890").
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('base32 round-trips and matches the RFC secret encoding', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (let len = 1; len <= 32; len++) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 255));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  }
  assert.deepEqual(totp.base32Decode('gezd gnbv-gy3t'), totp.base32Decode('GEZDGNBVGY3T'));
  assert.throws(() => totp.base32Decode('ABC1'));
});

test('TOTP codes match the RFC 6238 vectors (8 and 6 digits)', () => {
  for (const [seconds, code] of VECTORS) {
    assert.equal(totp.totp(RFC_SECRET, { time: seconds * 1000, digits: 8 }), code, `t=${seconds}`);
    assert.equal(totp.totp(RFC_SECRET, { time: seconds * 1000 }), code.slice(-6), `t=${seconds} (6 digits)`);
  }
});

test('verification accepts +/- one 30s step and returns the matched step', () => {
  const secret = totp.generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const t0 = Date.UTC(2026, 9, 18, 12, 0, 15);
  const step = totp.stepAt(t0);
  const code = totp.totp(secret, { time: t0 });
  assert.equal(totp.verifyTotp(secret, code, { time: t0 }), step);
  assert.equal(totp.verifyTotp(secret, code, { time: t0 + 30000 }), step);
  assert.equal(totp.verifyTotp(secret, code, { time: t0 - 30000 }), step);
  assert.equal(totp.verifyTotp(secret, code, { time: t0 + 90000 }), null);
  assert.equal(totp.verifyTotp(secret, '12345', { time: t0 }), null);
  assert.equal(totp.verifyTotp(secret, 'abcdef', { time: t0 }), null);
  assert.equal(totp.verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { time: t0 }), step);
});

test('otpauth URI is Google Authenticator compatible', () => {
  const uri = totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'admin', issuer: 'Fund Manager' });
  const url = new URL(uri);
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'Fund Manager:admin');
  assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(url.searchParams.get('issuer'), 'Fund Manager');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});
