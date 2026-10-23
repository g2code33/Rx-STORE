/**
 * Android launcher icon geometry.
 *
 * PRODUCTION BUG: the RX Store icon looked oversized on Android home screens —
 * the artwork filled 85% of the adaptive-icon canvas, but only the central ~66dp
 * of the 108dp canvas is guaranteed visible (every launcher masks the rest), so
 * the logo collided with the mask on every device.
 *
 * These tests decode the shipped PNGs (zlib + PNG unfiltering, no dependencies)
 * and fail if the artwork grows back out of its safe zone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

// This file lives in src/platform/, the assets in android/app/src/main/res/.
const RES = new URL('../../android/app/src/main/res/', import.meta.url).pathname;

interface Rgba { width: number; height: number; data: Uint8Array }

/** Decode a non-interlaced 8-bit RGBA PNG (what the launcher assets are). */
export function decodeRgbaPng(buf: Buffer): Rgba {
  assert.equal(buf.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n', 'not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'IDAT') idat.push(Buffer.from(chunk));
    else if (type === 'IEND') break;
    pos += len + 12;
  }
  assert.equal(bitDepth, 8, 'expected 8-bit channels');
  assert.equal(colorType, 6, 'expected RGBA');
  assert.equal(interlace, 0, 'expected non-interlaced');

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Uint8Array.prototype.slice.call(raw, p, p + stride);
    p += stride;
    if (filter === 1) for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
    else if (filter === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
    else if (filter === 3) for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? line[i - bpp] : 0;
      line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
    } else if (filter === 4) for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (line[i] + pr) & 0xff;
    }
    out.set(line, y * stride);
    prev = line;
  }
  return { width, height, data: out };
}

/** Bounding box of pixels whose alpha is above `threshold`, in fractions of the canvas. */
export function artBox(img: Rgba, threshold = 8): { left: number; top: number; right: number; bottom: number; widthPct: number; heightPct: number } | null {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX, top: minY, right: maxX, bottom: maxY,
    widthPct: ((maxX - minX + 1) / img.width) * 100,
    heightPct: ((maxY - minY + 1) / img.height) * 100,
  };
}

function assets(kind: 'ic_launcher_foreground' | 'ic_launcher' | 'ic_launcher_round') {
  const out: Array<{ path: string; density: string }> = [];
  for (const dir of readdirSync(RES)) {
    if (!dir.startsWith('mipmap-')) continue;
    const file = join(RES, dir, `${kind}.png`);
    try { readFileSync(file); out.push({ path: file, density: dir }); } catch { /* not this density */ }
  }
  return out;
}

test('adaptive foreground stays inside the launcher safe zone (<= 58% of the canvas)', () => {
  const list = assets('ic_launcher_foreground');
  assert.ok(list.length >= 4, 'all densities are shipped');
  for (const { path, density } of list) {
    const box = artBox(decodeRgbaPng(readFileSync(path)));
    assert.ok(box, `${density}: the foreground must contain artwork`);
    // 108dp canvas, only ~66dp guaranteed visible; 58% keeps a real margin so
    // the logo never touches the mask.
    assert.ok(box!.widthPct <= 58, `${density}: artwork is ${box!.widthPct.toFixed(1)}% wide (max 58%)`);
    assert.ok(box!.heightPct <= 58, `${density}: artwork is ${box!.heightPct.toFixed(1)}% tall (max 58%)`);
    // …and it must still be big enough to be legible.
    assert.ok(Math.max(box!.widthPct, box!.heightPct) >= 40, `${density}: artwork is too small to read`);
  }
});

test('legacy square + round icons are padded too', () => {
  for (const kind of ['ic_launcher', 'ic_launcher_round'] as const) {
    for (const { path, density } of assets(kind)) {
      const box = artBox(decodeRgbaPng(readFileSync(path)));
      assert.ok(box, `${density}/${kind}: must contain artwork`);
      const limit = kind === 'ic_launcher_round' ? 68 : 78;
      assert.ok(box!.widthPct <= limit, `${density}/${kind}: ${box!.widthPct.toFixed(1)}% wide (max ${limit}%)`);
      assert.ok(box!.heightPct <= limit, `${density}/${kind}: ${box!.heightPct.toFixed(1)}% tall (max ${limit}%)`);
    }
  }
});

test('the round icon fits inside its circular mask (no clipped corners)', () => {
  for (const { path, density } of assets('ic_launcher_round')) {
    const img = decodeRgbaPng(readFileSync(path));
    const cx = img.width / 2, cy = img.height / 2, r = img.width / 2;
    let furthest = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] > 8) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d > furthest) furthest = d;
        }
      }
    }
    assert.ok(furthest <= r, `${density}: artwork reaches ${furthest.toFixed(1)}px from centre, circle radius is ${r.toFixed(1)}px`);
  }
});

test('every density exists for the three launcher assets', () => {
  const densities = readdirSync(RES).filter((d) => d.startsWith('mipmap-') && d !== 'mipmap-anydpi-v26');
  assert.ok(densities.length >= 5, 'mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi are all present');
  for (const kind of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'] as const) {
    assert.equal(assets(kind).length, densities.length, `${kind} exists for every density`);
  }
  // The adaptive-icon XML must point at the padded foreground, not a raw bitmap.
  const adaptive = readFileSync(join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8');
  assert.match(adaptive, /android:drawable="@mipmap\/ic_launcher_foreground"/);
  assert.match(adaptive, /android:drawable="@color\/ic_launcher_background"/);
});
