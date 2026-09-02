#!/usr/bin/env node
/**
 * Generates the runner's PNG icons.
 *
 * Written by hand rather than pulled from an image library: the icons are flat
 * shapes, and a build that depends on a native image toolchain is a build that
 * breaks on somebody's machine. PNG is required rather than SVG because iOS
 * ignores SVG for apple-touch-icon, and Android wants raster maskables.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/runner/public/icons");

const BG = [17, 24, 39];      // slate-900
const FG = [129, 140, 248];   // indigo-400

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A rounded square with a lighter inset square: a cartridge, roughly. */
function pixel(x, y, size, padding) {
  const inset = size * 0.22;
  const radius = size * 0.18;

  // Rounded-corner test on the outer square.
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return null; // transparent

  const inner = x > inset && x < size - inset && y > inset && y < size - inset * 1.6;
  return inner ? FG : BG;
}

function png(size, padding = 0) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const colour = pixel(x, y, size, padding);
      if (colour) {
        raw[offset++] = colour[0];
        raw[offset++] = colour[1];
        raw[offset++] = colour[2];
        raw[offset++] = 255;
      } else {
        offset += 4; // left zeroed: fully transparent
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(resolve(out, `icon-${size}.png`), png(size));
}
// iOS composites its own rounded mask and background, so this one is opaque.
writeFileSync(resolve(out, "apple-touch-icon.png"), png(180));
console.log("[dai] wrote runner icons to apps/runner/public/icons");
