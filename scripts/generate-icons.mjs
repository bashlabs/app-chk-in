/**
 * Generates the PWA icon set with no image dependencies — raw RGBA pixels
 * encoded straight to PNG with node:zlib.
 *
 * Run: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const iconsDir = join(publicDir, 'icons');

const BRAND = [79, 70, 229]; // indigo-600
const WHITE = [255, 255, 255];

// ---------------------------------------------------------------- PNG encoder

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
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba RGBA pixels, row-major */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace = 0

  // Prefix each scanline with filter byte 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- drawing

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (!inRect(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param {number} size
 * @param {object} opts
 * @param {number} opts.pad      padding around the tile, as a fraction of size
 * @param {number} opts.radius   corner radius, as a fraction of the tile
 * @param {number} opts.glyph    cross height, as a fraction of size
 */
function drawIcon(size, { pad, radius, glyph }) {
  const px = new Uint8Array(size * size * 4);
  const SS = 3; // 3x3 supersampling for antialiasing

  const p = size * pad;
  const tile = { x0: p, y0: p, x1: size - p, y1: size - p };
  const r = (tile.x1 - tile.x0) * radius;

  // Cross: vertical bar + horizontal bar, upper-weighted like a latin cross.
  const c = size / 2;
  const h = size * glyph;
  const barW = h * 0.22;
  const vy0 = c - h / 2;
  const vy1 = c + h / 2;
  const armW = h * 0.66;
  const hy = c - h * 0.12; // crossbar sits above centre

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS;
          const py_ = y + (sy + 0.5) / SS;

          if (inRoundedRect(px_, py_, tile.x0, tile.y0, tile.x1, tile.y1, r)) bg++;

          const onCross =
            inRect(px_, py_, c - barW / 2, vy0, c + barW / 2, vy1) ||
            inRect(px_, py_, c - armW / 2, hy - barW / 2, c + armW / 2, hy + barW / 2);
          if (onCross) fg++;
        }
      }

      const total = SS * SS;
      const bgA = bg / total;
      const fgA = fg / total;

      // Composite: white cross over brand tile over transparency.
      const alpha = Math.max(bgA, fgA);
      const i = (y * size + x) * 4;
      if (alpha === 0) continue;

      const mix = fgA / Math.max(alpha, 1e-6);
      for (let ch = 0; ch < 3; ch++) {
        px[i + ch] = Math.round(BRAND[ch] * (1 - mix) + WHITE[ch] * mix);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(px, size);
}

// -------------------------------------------------------------------- output

await mkdir(iconsDir, { recursive: true });

const targets = [
  // Standard icons: rounded tile with a little breathing room.
  [join(iconsDir, 'icon-192.png'), 192, { pad: 0.03, radius: 0.22, glyph: 0.5 }],
  [join(iconsDir, 'icon-512.png'), 512, { pad: 0.03, radius: 0.22, glyph: 0.5 }],
  // Maskable: full bleed, glyph inside the 80% safe zone.
  [join(iconsDir, 'maskable-512.png'), 512, { pad: 0, radius: 0, glyph: 0.38 }],
  // iOS home screen: square, no transparency, no rounding (iOS masks it).
  [join(publicDir, 'apple-touch-icon.png'), 180, { pad: 0, radius: 0, glyph: 0.5 }],
  [join(publicDir, 'favicon.png'), 64, { pad: 0, radius: 0.2, glyph: 0.56 }],
];

for (const [path, size, opts] of targets) {
  await writeFile(path, drawIcon(size, opts));
  console.log(`wrote ${path.replace(root + '/', '')} (${size}x${size})`);
}
