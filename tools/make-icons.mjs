/**
 * Draws the brand icons as PNG, with no dependency and no design tool.
 *
 * They are committed as files rather than generated at boot, because a browser
 * and a crawler ask for them before anything else and a generated one is a
 * request the server has to serve on its slowest path. This exists so the next
 * person can change the mark without owning Illustrator, and so the icons can
 * be shown to have been produced from the brand rather than found somewhere.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAVY = [0x0f, 0x1b, 0x2a];
const AMBER = [0xef, 0xa1, 0x3c];
const WHITE = [0xf4, 0xf8, 0xfc];

/** CRC32, which every PNG chunk is required to carry. */
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Writes an RGB pixel buffer as a PNG. */
function png(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 2;   // truecolour
  // Each row is prefixed with its filter type. Zero, meaning none: these are
  // flat shapes and the compressor does better on them than a filter would.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0;
    pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from a point to a line segment, for drawing a stroke. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The mark: an amber dot and a thin chevron on navy.
 *
 * Sampled four times per pixel, because an icon at 180 pixels with hard edges
 * looks like a mistake at any smaller size, and every launcher shows it smaller.
 */
function drawMark(size) {
  const pixels = Buffer.alloc(size * size * 3);
  const s = size / 100;
  const dot = { x: 34 * s, y: 50 * s, r: 13 * s };
  const chevron = { x: 72 * s, y: 50 * s, arm: 13 * s, width: 6.5 * s };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = x + ox;
        const py = y + oy;
        let colour = NAVY;
        if (Math.hypot(px - dot.x, py - dot.y) <= dot.r) colour = AMBER;
        const toChevron = Math.min(
          distanceToSegment(px, py, chevron.x, chevron.y - chevron.arm,
            chevron.x - chevron.arm, chevron.y),
          distanceToSegment(px, py, chevron.x - chevron.arm, chevron.y,
            chevron.x, chevron.y + chevron.arm),
        );
        if (toChevron <= chevron.width / 2) colour = WHITE;
        r += colour[0];
        g += colour[1];
        b += colour[2];
      }
      const at = (y * size + x) * 3;
      pixels[at] = Math.round(r / 4);
      pixels[at + 1] = Math.round(g / 4);
      pixels[at + 2] = Math.round(b / 4);
    }
  }
  return png(size, size, pixels);
}

const target = fileURLToPath(new URL('../packages/server/public/', import.meta.url));
// 180 is what iOS asks for, and it downscales cleanly to every other size.
writeFileSync(`${target}apple-touch-icon.png`, drawMark(180));
console.log('wrote apple-touch-icon.png (180x180)');
