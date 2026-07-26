/**
 * Pinned-runtime acquisition for the installer (Phase 5).
 *
 * The installer bundles a pinned Node runtime (decision: bundled Node, not
 * SEA) so the customer's system Node — and the whole better-sqlite3 ABI
 * mismatch class — becomes irrelevant. Node archives are verified against
 * nodejs.org's SHASUMS256.txt at build time; winsw is verified against a
 * hash pinned here (captured from the official v2.12.0 release).
 */
import { createHash } from 'node:crypto'

export const NODE_BUNDLE_VERSION = '20.20.2'

export const WINSW = {
  version: '2.12.0',
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
}

/** Official dist filename for a platform/arch. */
export function nodeDistName(platform: string, arch: string, version: string): string {
  if (platform === 'win32') return `node-v${version}-win-${arch}.zip`
  return `node-v${version}-${platform}-${arch}.tar.gz`
}

/** Hash for a filename from a SHASUMS256.txt body. Throws when absent — a
 * download we cannot verify is a download we do not use. */
export function parseShasums(text: string, filename: string): string {
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{6,})[\s\t]+(.+)$/.exec(line.trim())
    if (m && m[2].trim() === filename) return m[1]
  }
  throw new Error(`checksum for ${filename} not found in SHASUMS256.txt`)
}

export async function fetchNodeShasums(version: string): Promise<string> {
  const res = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  if (!res.ok) throw new Error(`SHASUMS256.txt fetch failed: HTTP ${res.status}`)
  return res.text()
}

/** Download and verify against an expected sha256. */
export async function downloadVerified(url: string, expectedSha256: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(`sha256 mismatch for ${url}\n  expected ${expectedSha256}\n  got      ${actual}`)
  }
  return buf
}
