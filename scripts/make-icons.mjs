/**
 * Generates the PWA icons with no image tooling and no dependencies.
 *
 * There is no rasteriser on this machine and the icon is pure geometry, so we
 * evaluate signed-distance fields into a pixel buffer, supersample for clean
 * edges, and encode the PNG with node:zlib.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../client/public/', import.meta.url))
const BG = [0xfa, 0xf9, 0xf7]
const INK = [0x9a, 0x5b, 0x2c]
const SS = 4 // supersampling factor

/** Signed distance to a rounded rectangle centred on the origin. */
const roundRect = (x, y, halfW, halfH, r) => {
  const dx = Math.abs(x) - halfW + r
  const dy = Math.abs(y) - halfH + r
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

/** Coverage of the book glyph at a point, in design units (512 box, origin centred). */
function glyph(x, y, scale) {
  const X = x / scale
  const Y = y / scale

  // The cover: a ring, so the shape reads at 192px as well as 512.
  const outer = roundRect(X, Y, 186, 148, 26)
  const inner = roundRect(X, Y, 160, 122, 14)
  const ring = outer <= 0 && inner > 0

  // The gutter, plus two short rules on each leaf: lines of text on facing
  // pages. Without them the ring reads as a window rather than a book.
  const gutter = Math.abs(X) <= 11 && Math.abs(Y) <= 148

  let text = false
  for (const ty of [-46, 6, 58]) {
    // Left page and right page, inset from the gutter and the cover alike.
    const onLine = Math.abs(Y - ty) <= 8
    const leftPage = X <= -38 && X >= -132
    const rightPage = X >= 38 && X <= 132
    if (onLine && (leftPage || rightPage)) text = true
  }

  return ring || gutter || text
}

function render(size, maskable) {
  const dim = size * SS
  const acc = new Float32Array(size * size)
  // Maskable icons must survive a circular crop, so keep to the safe zone.
  const scale = (size / 512) * (maskable ? 0.72 : 0.92) * SS

  for (let py = 0; py < dim; py++) {
    const y = py - dim / 2 + 0.5
    for (let px = 0; px < dim; px++) {
      const x = px - dim / 2 + 0.5
      if (glyph(x, y, scale)) {
        acc[Math.floor(py / SS) * size + Math.floor(px / SS)] += 1
      }
    }
  }

  const rgba = Buffer.alloc(size * size * 4)
  const samples = SS * SS
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, acc[i] / samples)
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = Math.round(BG[c] * (1 - a) + INK[c] * a)
    }
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

// --- minimal PNG encoder ----------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
]) {
  const png = encodePNG(render(size, maskable), size)
  writeFileSync(OUT + name, png)
  console.log(`${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`)
}
