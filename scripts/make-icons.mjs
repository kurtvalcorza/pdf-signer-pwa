#!/usr/bin/env node
// Generate PWA icons (192, 512, maskable-512) with a dependency-free PNG encoder.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// --- minimal PNG (RGBA) encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---
function icon(size, { pad = 0 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b, a = 255]) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const disc = (cx, cy, r, color) => {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx + x, cy + y, color);
  };
  const stroke = (pts, r, color) => {
    for (let s = 0; s < pts.length - 1; s++) {
      const [x0, y0] = pts[s];
      const [x1, y1] = pts[s + 1];
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
      for (let t = 0; t <= steps; t++) disc(x0 + ((x1 - x0) * t) / steps, y0 + ((y1 - y0) * t) / steps, r, color);
    }
  };

  // Background (theme color) fills the whole canvas.
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = 0x1c;
    px[i * 4 + 1] = 0x1c;
    px[i * 4 + 2] = 0x1e;
    px[i * 4 + 3] = 255;
  }

  const inset = pad * size;
  const S = size - 2 * inset; // content box side
  const ox = inset;
  const oy = inset;
  const p = (fx, fy) => [ox + fx * S, oy + fy * S];

  // Baseline (subtle).
  stroke([p(0.18, 0.72), p(0.82, 0.72)], Math.max(1, S * 0.006), [255, 255, 255, 90]);
  // Signature swash (blue).
  const blue = [59, 130, 246, 255];
  stroke(
    [
      p(0.2, 0.62),
      p(0.32, 0.4),
      p(0.42, 0.66),
      p(0.54, 0.34),
      p(0.66, 0.64),
      p(0.8, 0.44),
    ],
    Math.max(2, S * 0.03),
    blue,
  );
  return encodePng(size, size, px);
}

const DIR = resolve('public/icons');
mkdirSync(DIR, { recursive: true });
writeFileSync(resolve(DIR, 'icon-192.png'), icon(192));
writeFileSync(resolve(DIR, 'icon-512.png'), icon(512));
writeFileSync(resolve(DIR, 'icon-maskable-512.png'), icon(512, { pad: 0.16 })); // safe zone
console.log(`icons written to ${DIR}`);
