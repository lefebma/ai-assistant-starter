/**
 * Generate the default Havn "H" logo icons for Teams.
 *
 *   npx tsx scripts/generate-havn-icons.ts
 *
 * Writes:
 *   deploy/teams/color.png   — 192x192, white H on dark background
 *   deploy/teams/outline.png — 32x32,  white H on transparent background
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

// --- PNG primitives (same as teams-package.ts) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function makePng(width: number, height: number, pixelFn: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4) // filter byte + pixels
    for (let x = 0; x < width; x++) {
      row.set(pixelFn(x, y), 1 + x * 4)
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// --- H glyph test ---

function isH(x: number, y: number, size: number): boolean {
  // Proportional H in a square canvas
  const pad = Math.round(size * 0.16)         // outer padding
  const stroke = Math.round(size * 0.17)       // bar thickness
  const left = pad
  const right = size - pad - stroke
  const crossTop = Math.round((size - stroke) / 2)

  // Left vertical
  if (x >= left && x < left + stroke && y >= pad && y < size - pad) return true
  // Right vertical
  if (x >= right && x < right + stroke && y >= pad && y < size - pad) return true
  // Crossbar
  if (x >= left && x < right + stroke && y >= crossTop && y < crossTop + stroke) return true

  return false
}

// --- Generate ---

const BG: [number, number, number, number] = [31, 41, 55, 255]   // #1F2937
const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const CLEAR: [number, number, number, number] = [0, 0, 0, 0]

const colorPng = makePng(192, 192, (x, y) => isH(x, y, 192) ? WHITE : BG)
const outlinePng = makePng(32, 32, (x, y) => isH(x, y, 32) ? WHITE : CLEAR)

const dir = resolve(import.meta.dirname ?? '.', '..', 'deploy', 'teams')
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'color.png'), colorPng)
writeFileSync(resolve(dir, 'outline.png'), outlinePng)

console.log(`Wrote deploy/teams/color.png (${colorPng.length} bytes) and deploy/teams/outline.png (${outlinePng.length} bytes)`)
