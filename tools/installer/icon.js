'use strict';

// Draws the Slate desktop icon and packs it into a Windows .ico file.
//
// Zero dependencies, same as the rest of the app: the mark is one arc, so we
// render it with plain math (4x supersampled) instead of decoding the PNGs in
// branding/. That also lets us render each icon size from scratch, so the small
// 16px taskbar version stays crisp instead of being a squashed 512px image.

// Brand colors (branding/brand-colors.txt).
const BG = [0x1f, 0x25, 0x2c]; // #1F252C card/surface — reads on any wallpaper
const ARC = [0x8c, 0xa8, 0x91]; // #8CA891 sage accent

// ---- geometry ------------------------------------------------------------
// The mark, in the 512x512 viewBox from branding/slate-mark-dark.svg:
//   <path d="M128 320 A128 128 0 0 1 384 320" stroke-width="52" linecap="round"/>
// An upper half circle centred at (256,320) with radius 128, stroked 52 wide
// with round caps. Its bounding box is centred on (256,256).
const CX = 256, CY = 320, R = 128, HALF_STROKE = 26;
const MARK_WIDTH = 2 * (R + HALF_STROKE); // 308 viewBox units across
const MARK_FRACTION = 0.64; // how much of the tile the mark spans

// Distance from a point (in viewBox space) to the stroked arc's centre line.
function distToArc(x, y) {
  const dx = x - CX, dy = y - CY;
  if (dy <= 0) return Math.abs(Math.hypot(dx, dy) - R); // on the arc's span
  // Past the ends: nearest round cap.
  return Math.min(Math.hypot(x - (CX - R), dy), Math.hypot(x - (CX + R), dy));
}

// Distance outside a rounded square covering [0,size] with the given radius.
// Negative inside, positive outside.
function distToRoundedSquare(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Renders one square icon as raw RGBA bytes.
function renderRgba(size) {
  const SS = 4; // supersample factor per axis
  const scale = (MARK_FRACTION * size) / MARK_WIDTH; // viewBox units -> pixels
  const radius = size * 0.22;
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, arcHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (distToRoundedSquare(x, y, size, radius) > 0) continue;
          bgHits++;
          // Map the pixel back into the 512-unit viewBox. The mark's bounding
          // box is centred on (256,256) there, so the tile centre maps to it.
          const vx = (x - size / 2) / scale + 256;
          const vy = (y - size / 2) / scale + 256;
          if (distToArc(vx, vy) <= HALF_STROKE) arcHits++;
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (bgHits === 0) continue; // fully transparent corner
      // Blend the sage arc over the tile, then apply the tile's own coverage
      // as alpha so the rounded corners stay smooth.
      const arcMix = arcHits / bgHits;
      out[i] = Math.round(BG[0] + (ARC[0] - BG[0]) * arcMix);
      out[i + 1] = Math.round(BG[1] + (ARC[1] - BG[1]) * arcMix);
      out[i + 2] = Math.round(BG[2] + (ARC[2] - BG[2]) * arcMix);
      out[i + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return out;
}

// ---- BMP (the classic in-icon format) ------------------------------------
// A bottom-up 32-bit DIB with a 1bpp AND mask — the classic in-icon format,
// used here for every size including 256. Windows also accepts a PNG payload at
// 256px and that would be a third of the file size, but an uncompressed DIB is
// what the widest range of icon readers understands, and a few hundred KB on
// local disk buys nothing worth optimising for.
//
// (Don't be fooled by System.Drawing reporting 128x128 when asked for 256 — it
// reads the directory's dimension byte literally, and 256 is stored there as 0,
// so it can never match that entry whatever format it holds. Explorer is fine.)
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows + mask rows
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  // compression BI_RGB (0) and the remaining fields stay zero.

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // DIB rows run bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: all zeros (show everything) but the rows must still be present,
  // padded to a 4-byte boundary.
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

// ---- ICO container -------------------------------------------------------
const SIZES = [256, 128, 64, 48, 32, 16];

function buildIco(sizes = SIZES) {
  const images = sizes.map((size) => ({ size, data: encodeDib(renderRgba(size), size) }));

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 0 means 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette colours
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    return e;
  });

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

module.exports = { buildIco, renderRgba, SIZES };
