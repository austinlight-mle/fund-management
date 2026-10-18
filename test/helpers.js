'use strict';

const { openDatabase } = require('../src/core/db');
const { createServices } = require('../src/core/services');

/** Fresh in-memory database with all services and a controllable clock. */
function setup({ now = '2026-10-18T12:00:00' } = {}) {
  const clock = {
    current: new Date(now),
    now() {
      return new Date(this.current);
    },
    set(value) {
      this.current = new Date(value);
    },
    advance(ms) {
      this.current = new Date(this.current.getTime() + ms);
    },
  };
  const db = openDatabase(':memory:');
  return { ...createServices(db, { clock }), db, clock };
}

/** Logs in as the default admin and completes the forced password change. */
function loginAdmin(s, newPassword = 'secret123') {
  s.auth.login({ username: 'admin', password: 'admin' });
  s.auth.changeCredentials({ currentPassword: 'admin', newPassword });
  return s.auth.status();
}

/** Small deterministic PRNG (mulberry32) so "random" test data is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Expects fn() to throw an AppError with the given code. */
function throwsCode(assert, fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `expected ${code} but got ${err.code} (${err.message})`);
    return true;
  });
}

module.exports = { setup, loginAdmin, prng, pad2, throwsCode };
