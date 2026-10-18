'use strict';

/*
 * Renders the app icon (build/icon.png, 1024×1024) without any dependencies:
 * the two-coin logo from the sidebar, white on a blue rounded square.
 * electron-builder turns it into .ico / .icns / Linux icons.
 *
 *   node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SAMPLES = 4; // 4×4 supersampling for smooth edges

// Background: rounded square with a diagonal blue gradient.
const INSET = 64;
const RADIUS = 200;
const TOP = [59, 130, 246]; // #3b82f6
const BOTTOM = [29, 78, 216]; // #1d4ed8

// Logo in the 24-unit space of the sidebar icon:
// a full coin at (9,9) and a second coin at (15.5,15.5) with its top-left quarter cut away.
const SCALE = 28;
const CENTER = 12.25;
const STROKE = 2.2;
const COIN = 6;

function roundedSquare(x, y) {
  const half = (SIZE - 2 * INSET) / 2;
  const qx = Math.abs(x - SIZE / 2) - (half - RADIUS);
  const qy = Math.abs(y - SIZE / 2) - (half - RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - RADIUS <= 0;
}

function logo(x, y) {
  const u = (x - SIZE / 2) / SCALE + CENTER;
  const v = (y - SIZE / 2) / SCALE + CENTER;
  const w = STROKE / 2;
  if (Math.abs(Math.hypot(u - 9, v - 9) - COIN) <= w) return true;
  const onSecond = Math.abs(Math.hypot(u - 15.5, v - 15.5) - COIN) <= w;
  if (onSecond && !(u < 15.5 && v < 15.5)) return true;
  // Round caps where the second coin's arc ends.
  return Math.hypot(u - 15.5, v - 9.5) <= w || Math.hypot(u - 9.5, v - 15.5) <= w;
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const n = SAMPLES * SAMPLES;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (roundedSquare(px, py)) {
            bg += 1;
            if (logo(px, py)) fg += 1;
          }
        }
      }
      const t = (x + y) / (2 * SIZE);
      const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
      const f = bg ? fg / bg : 0;
      const o = (y * SIZE + x) * 4;
      for (let i = 0; i < 3; i++) rgba[o + i] = Math.round(base[i] * (1 - f) + 255 * f);
      rgba[o + 3] = Math.round((bg / n) * 255);
    }
  }
  return rgba;
}

// ---- minimal PNG encoder -------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(render(), SIZE, SIZE));
console.log(`Wrote ${out}`);
