'use strict';

const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(password, salt, n, r, p) {
  return crypto.scryptSync(String(password), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
}

/** Returns a self-describing hash string: scrypt$N$r$p$salt$hash (base64). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = derive(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
