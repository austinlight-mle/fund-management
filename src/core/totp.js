'use strict';

// RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation compatible with
// Google Authenticator: HMAC-SHA1, 6 digits, 30 second period.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

function hotp(key, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function stepAt(timeMs) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

function totp(secretBase32, { time = Date.now(), digits = DIGITS } = {}) {
  return hotp(base32Decode(secretBase32), stepAt(time), digits);
}

/**
 * Verifies a token allowing +/- `window` steps of clock drift.
 * Returns the matched time step (for replay protection) or null.
 */
function verifyTotp(secretBase32, token, { time = Date.now(), window = 1, digits = DIGITS } = {}) {
  const normalized = String(token || '').replace(/\s/g, '');
  if (!/^\d+$/.test(normalized) || normalized.length !== digits) return null;
  const key = base32Decode(secretBase32);
  const current = stepAt(time);
  for (let delta = -window; delta <= window; delta++) {
    const candidate = hotp(key, current + delta, digits);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) return current + delta;
  }
  return null;
}

function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, otpauthUri, stepAt };
