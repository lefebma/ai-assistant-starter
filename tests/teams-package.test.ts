import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { renderManifest, solidPng, buildTeamsPackage, validateTeamsPackageSpec } from '../src/deploy/teams-package.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = readFileSync(join(ROOT, 'deploy', 'teams', 'manifest.json.template'), 'utf-8')
const SPEC = { appId: '11111111-2222-3333-4444-555555555555', name: 'Nami' }

describe('validateTeamsPackageSpec', () => {
  it('wants a GUID app id and a name', () => {
    expect(validateTeamsPackageSpec(SPEC)).toEqual([])
    expect(validateTeamsPackageSpec({ appId: 'nope', name: 'Nami' }).join()).toMatch(/appId/)
    expect(validateTeamsPackageSpec({ appId: SPEC.appId, name: '' }).join()).toMatch(/name/)
    expect(validateTeamsPackageSpec({ appId: SPEC.appId, name: 'x'.repeat(31) }).join()).toMatch(/30/)
  })
})

describe('renderManifest', () => {
  it('produces a personal-scope bot manifest with the app id in both places', () => {
    const m = JSON.parse(renderManifest(TEMPLATE, SPEC))
    expect(m.manifestVersion).toBe('1.16')
    expect(m.id).toBe(SPEC.appId)
    expect(m.bots[0].botId).toBe(SPEC.appId)
    expect(m.bots[0].scopes).toEqual(['personal'])
    expect(m.bots[0].supportsFiles).toBe(true)
    expect(m.name.short).toBe('Nami')
    expect(m.icons).toEqual({ color: 'color.png', outline: 'outline.png' })
    expect(m.validDomains).toEqual([])
    expect(m.permissions).toEqual([])
    expect(JSON.stringify(m)).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })
})

describe('solidPng', () => {
  it('writes a decodable PNG of the requested size', () => {
    const png = solidPng(4, 2, [31, 41, 55, 255])
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(4) // width
    expect(png.readUInt32BE(20)).toBe(2) // height
    const idatLen = png.readUInt32BE(33)
    const idat = png.subarray(41, 41 + idatLen)
    const raw = inflateSync(idat)
    expect(raw.length).toBe(2 * (1 + 4 * 4)) // filter byte + RGBA per row
    expect([...raw.subarray(1, 5)]).toEqual([31, 41, 55, 255])
  })
})

describe('buildTeamsPackage', () => {
  it('zips manifest.json, color.png, and outline.png as stored entries', () => {
    const zip = buildTeamsPackage(TEMPLATE, SPEC)
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const text = zip.toString('latin1')
    for (const name of ['manifest.json', 'color.png', 'outline.png']) expect(text).toContain(name)
    // end-of-central-directory record says 3 entries
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(zip.readUInt16LE(eocd + 10)).toBe(3)
  })

  it('uses the default Havn icons in deploy/teams when given the project root', () => {
    const zip = buildTeamsPackage(TEMPLATE, SPEC, ROOT)
    expect(zip.indexOf(readFileSync(join(ROOT, 'deploy', 'teams', 'color.png')))).toBeGreaterThan(0)
    expect(zip.indexOf(readFileSync(join(ROOT, 'deploy', 'teams', 'outline.png')))).toBeGreaterThan(0)
  })

  it('prefers icons passed explicitly, and generates them when nothing is on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-icons-'))
    const color = solidPng(192, 192, [200, 10, 10, 255])
    const outline = solidPng(32, 32, [255, 255, 255, 255])
    writeFileSync(join(dir, 'c.png'), color)
    writeFileSync(join(dir, 'o.png'), outline)
    const zip = buildTeamsPackage(TEMPLATE, { ...SPEC, colorIconPath: join(dir, 'c.png'), outlineIconPath: join(dir, 'o.png') }, ROOT)
    expect(zip.indexOf(color)).toBeGreaterThan(0)
    expect(zip.indexOf(outline)).toBeGreaterThan(0)
    const bare = mkdtempSync(join(tmpdir(), 'teams-root-'))
    mkdirSync(join(bare, 'deploy', 'teams'), { recursive: true })
    expect(buildTeamsPackage(TEMPLATE, SPEC, bare).indexOf(solidPng(192, 192, [31, 41, 55, 255]))).toBeGreaterThan(0)
  })

  it('refuses an explicit icon that is missing, not a PNG, or the wrong size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-bad-'))
    writeFileSync(join(dir, 'big.png'), solidPng(256, 256, [0, 0, 0, 255]))
    writeFileSync(join(dir, 'x.png'), 'not a png at all, just text padding')
    expect(() => buildTeamsPackage(TEMPLATE, { ...SPEC, colorIconPath: join(dir, 'nope.png') })).toThrow(/--color-icon: cannot read/)
    expect(() => buildTeamsPackage(TEMPLATE, { ...SPEC, colorIconPath: join(dir, 'x.png') })).toThrow(/not a PNG/)
    expect(() => buildTeamsPackage(TEMPLATE, { ...SPEC, colorIconPath: join(dir, 'big.png') })).toThrow(/256x256, Teams needs 192x192/)
    expect(() => buildTeamsPackage(TEMPLATE, { ...SPEC, outlineIconPath: join(dir, 'big.png') })).toThrow(/--outline-icon/)
  })
})
