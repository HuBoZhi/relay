/**
 * Draws the tray and application icons without any image dependency.
 *
 * A desktop build needs a real `.ico` (Windows) and a PNG (everywhere else).
 * Pulling in a rasterizer for two glyphs would cost more than it saves, so this
 * script draws the brand mark from geometry, supersamples it for anti-aliasing,
 * encodes PNG by hand, and packs the ICO container around those PNGs.
 *
 * Run `npm run icons` after changing the artwork; the output is committed so a
 * packaging run never needs this script.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');
const SUPERSAMPLE = 3;

const TOP = [0x10, 0x24, 0x2b];
const BOTTOM = [0x0a, 0x10, 0x15];
const BORDER = [0x2e, 0x5a, 0x63];
const CYAN = [0x7c, 0xe7, 0xd5];

function blend(base, top, alpha) {
  return [
    Math.round(base[0] * (1 - alpha) + top[0] * alpha),
    Math.round(base[1] * (1 - alpha) + top[1] * alpha),
    Math.round(base[2] * (1 - alpha) + top[2] * alpha),
  ];
}

function gradientRow(y, size) {
  const t = y / Math.max(1, size - 1);
  return [
    Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
  ];
}

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const halfW = (right - left) / 2 - radius;
  const halfH = (bottom - top) / 2 - radius;
  const dx = Math.abs(x - cx) - halfW;
  const dy = Math.abs(y - cy) - halfH;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function draw(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const inset = size * 0.055;
  const radius = size * 0.235;
  const border = Math.max(1, size * 0.012);
  const diamond = size * 0.3;
  const diamondStroke = size * 0.055;
  const core = size * 0.115;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const distance = roundedRectDistance(
        x + 0.5,
        y + 0.5,
        inset,
        inset,
        size - inset,
        size - inset,
        radius
      );
      if (distance > 0.75) continue; // transparent outside the tile
      let color = gradientRow(y, size);
      if (distance > -border) {
        // One ring of border colour, anti-aliased against the tile edge.
        const coverage = Math.min(1, Math.max(0, 0.75 - distance + border));
        color = blend(color, BORDER, coverage);
      }
      const cx = size / 2;
      const cy = size / 2;
      const manhattan = Math.abs(x + 0.5 - cx) + Math.abs(y + 0.5 - cy);
      const ring = Math.abs(manhattan - diamond) - diamondStroke / 2;
      if (ring < 0.75) color = blend(color, CYAN, Math.min(1, Math.max(0, 0.75 - ring)));
      if (manhattan < core) {
        const coverage = Math.min(1, Math.max(0, core - manhattan + 0.5));
        color = blend(color, CYAN, coverage);
      }
      const alpha = distance > 0 ? Math.max(0, 0.75 - distance) * 0.85 : 1;
      px[index] = color[0];
      px[index + 1] = color[1];
      px[index + 2] = color[2];
      px[index + 3] = Math.round(255 * Math.min(1, alpha));
    }
  }
  return px;
}

function downsample(source, size, factor) {
  const target = size / factor;
  const out = new Uint8ClampedArray(target * target * 4);
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * size + (x * factor + sx)) * 4;
          sum[0] += source[index];
          sum[1] += source[index + 1];
          sum[2] += source[index + 2];
          sum[3] += source[index + 3];
        }
      }
      const index = (y * target + x) * 4;
      out[index] = Math.round(sum[0] / (factor * factor));
      out[index + 1] = Math.round(sum[1] / (factor * factor));
      out[index + 2] = Math.round(sum[2] / (factor * factor));
      out[index + 3] = Math.round(sum[3] / (factor * factor));
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Render an icon at `size` from a master drawing, so every size is crisp. */
function render(size) {
  const master = size * SUPERSAMPLE;
  return encodePng(size, downsample(draw(master), master, SUPERSAMPLE));
}

/** ICO container with PNG payloads (Vista and later). */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

mkdirSync(ASSETS, { recursive: true });

const iconPng = render(512);
const trayPng = render(32);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(icoSizes.map((size) => ({ size, data: render(size) })));

writeFileSync(join(ASSETS, 'icon.png'), iconPng);
writeFileSync(join(ASSETS, 'tray.png'), trayPng);
writeFileSync(join(ASSETS, 'icon.ico'), ico);

console.log(
  `已生成图标：icon.png ${iconPng.length} 字节 · tray.png ${trayPng.length} 字节 · icon.ico ${ico.length} 字节`
);
