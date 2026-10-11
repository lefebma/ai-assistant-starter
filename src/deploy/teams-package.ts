/**
 * Teams app package: manifest.json + two icons, zipped. Pure functions so the
 * shape is testable; scripts/teams-manifest.ts does the argv and file I/O.
 * The zip is written by hand (stored entries) to avoid a dependency.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

export interface TeamsPackageSpec {
  appId: string
  name: string
  developerName?: string
  websiteUrl?: string
  /** Path to a custom 192x192 color icon PNG. Falls back to deploy/teams/color.png, then generated. */
  colorIconPath?: string
  /** Path to a custom 32x32 outline icon PNG (white on transparent). Falls back to deploy/teams/outline.png, then generated. */
  outlineIconPath?: string
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateTeamsPackageSpec(spec: TeamsPackageSpec): string[] {
  const problems: string[] = []
  if (!GUID.test(spec.appId ?? '')) problems.push('appId must be the app (client) ID GUID from the registration')
  const name = (spec.name ?? '').trim()
  if (!name) problems.push('name is required')
  else if (name.length > 30) problems.push('name must be 30 characters or fewer (Teams short-name limit)')
  return problems
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'assistant'
}

export function renderManifest(template: string, spec: TeamsPackageSpec): string {
  const vars: Record<string, string> = {
    APP_ID: spec.appId.toLowerCase(),
    NAME: spec.name.trim(),
    SLUG: slugify(spec.name),
    DEVELOPER_NAME: spec.developerName?.trim() || 'ELS Partners',
    WEBSITE_URL: spec.websiteUrl?.trim() || 'https://www.els-partners.com',
  }
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in vars ? JSON.stringify(vars[key]).slice(1, -1) : m))
  const leftover = text.match(/\{\{[A-Z_]+\}\}/g)
  if (leftover) throw new Error(`manifest template still contains placeholders: ${[...new Set(leftover)].join(', ')}`)
  JSON.parse(text) // must be valid JSON
  return text
}

// --- PNG ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
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

/** A single-colour RGBA PNG. Enough for Teams' required icons. */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Outline icon: transparent background with a white square inset (Teams wants white-on-transparent). */
export function outlinePng(size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const inset = Math.floor(size / 8)
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      const on = x >= inset && x < size - inset && y >= inset && y < size - inset
      row.set(on ? [255, 255, 255, 255] : [0, 0, 0, 0], 1 + x * 4)
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

// --- ZIP (stored entries) ---

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function zipStored(entries: Array<{ name: string; data: Buffer }>, when = new Date()): Buffer {
  const { time, date } = dosDateTime(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, e.data)
    centrals.push(central, name)
    offset += local.length + name.length + e.data.length
  }
  const centralStart = offset
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, eocd])
}

/** Try to read a file; return undefined if it doesn't exist. */
function tryRead(path: string): Buffer | undefined {
  try { return readFileSync(path) } catch { return undefined }
}

/**
 * An icon the operator named explicitly: a missing file or a PNG of the wrong
 * size is an error, not a silent fall back to the default (Teams rejects the
 * whole package when an icon is not exactly the size it asks for).
 */
function readIcon(path: string, size: number, flag: string): Buffer {
  const data = tryRead(path)
  if (!data) throw new Error(`${flag}: cannot read ${path}`)
  const isPng = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) throw new Error(`${flag}: ${path} is not a PNG`)
  const w = data.readUInt32BE(16)
  const h = data.readUInt32BE(20)
  if (w !== size || h !== size) throw new Error(`${flag}: ${path} is ${w}x${h}, Teams needs ${size}x${size}`)
  return data
}

export function buildTeamsPackage(template: string, spec: TeamsPackageSpec, projectRoot?: string): Buffer {
  const problems = validateTeamsPackageSpec(spec)
  if (problems.length) throw new Error(problems.join('; '))

  const root = projectRoot ?? ''

  // Icon resolution: explicit path > convention path (deploy/teams/) > generated fallback
  const colorIcon =
    (spec.colorIconPath ? readIcon(spec.colorIconPath, 192, '--color-icon') : undefined) ??
    (root ? tryRead(resolve(root, 'deploy', 'teams', 'color.png')) : undefined) ??
    solidPng(192, 192, [31, 41, 55, 255])

  const outlineIcon =
    (spec.outlineIconPath ? readIcon(spec.outlineIconPath, 32, '--outline-icon') : undefined) ??
    (root ? tryRead(resolve(root, 'deploy', 'teams', 'outline.png')) : undefined) ??
    outlinePng(32)

  return zipStored([
    { name: 'manifest.json', data: Buffer.from(renderManifest(template, spec), 'utf-8') },
    { name: 'color.png', data: colorIcon },
    { name: 'outline.png', data: outlineIcon },
  ])
}
