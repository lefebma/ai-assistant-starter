/**
 * tests/outbound-files.test.ts
 *
 * `[[file: path]]`, the assistant's way of handing over an actual file.
 *
 * The path rules are not a security boundary and the module says so: the
 * assistant has a shell, so anything it can read it can copy somewhere
 * allowed, and the real boundary is that a file only ever goes to a chat
 * already authorized to talk to this assistant. What the rules buy is that a
 * careless or injected `[[file: .env]]` comes back as a refusal the owner can
 * see, instead of a key landing in a chat history that lives on a phone.
 * That is what these tests hold in place.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MAX_OUTBOUND_BYTES,
  MAX_OUTBOUND_FILES,
  extractFileMarkers,
  resolveOutboundFile,
} from '../src/outbound-files.js'
import { ensureFileMarkerSection } from '../src/update/conventions.js'

let projectRoot: string
let uploadsDir: string
let outside: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'outbound-project-'))
  uploadsDir = join(projectRoot, 'workspace', 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  outside = mkdtempSync(join(tmpdir(), 'outbound-outside-'))
})

const roots = (): { projectRoot: string; uploadsDir: string } => ({ projectRoot, uploadsDir })

function write(path: string, contents = 'x'): string {
  writeFileSync(path, contents)
  return path
}

describe('finding the marker', () => {
  it('pulls the path out and leaves the message clean', () => {
    const { cleanText, requests } = extractFileMarkers('Here is the chart.\n\n[[file: workspace/uploads/chart.png]]')
    expect(requests).toEqual([{ requested: 'workspace/uploads/chart.png' }])
    expect(cleanText).toBe('Here is the chart.')
  })

  it('takes several, and stops at the cap', () => {
    const markers = Array.from({ length: MAX_OUTBOUND_FILES + 3 }, (_, i) => `[[file: f${i}.pdf]]`).join(' ')
    const { requests } = extractFileMarkers(`Four at most. ${markers}`)
    expect(requests).toHaveLength(MAX_OUTBOUND_FILES)
    expect(requests[0].requested).toBe('f0.pdf')
  })

  it('leaves a reply with no marker exactly as it was', () => {
    const text = 'No files here. Just [[not a marker]] and a [link](https://example.com).'
    expect(extractFileMarkers(text)).toEqual({ cleanText: text, requests: [] })
  })

  it('does not leave a hole where the marker was', () => {
    const { cleanText } = extractFileMarkers('Report attached.   \n[[file: a.pdf]]\n\n\nAnything else?')
    expect(cleanText).toBe('Report attached.\n\nAnything else?')
  })
})

describe('deciding whether to send it', () => {
  it('accepts a file in the project, relative or absolute', () => {
    write(join(uploadsDir, 'chart.png'))
    expect(resolveOutboundFile('workspace/uploads/chart.png', roots())).toMatchObject({
      ok: true,
      name: 'chart.png',
      kind: 'photo',
    })
    expect(resolveOutboundFile(join(uploadsDir, 'chart.png'), roots())).toMatchObject({ ok: true, kind: 'photo' })
  })

  it('calls a pdf a document and a png a photo', () => {
    write(join(uploadsDir, 'report.pdf'))
    write(join(uploadsDir, 'shot.JPG'))
    expect(resolveOutboundFile('workspace/uploads/report.pdf', roots())).toMatchObject({ kind: 'document' })
    expect(resolveOutboundFile('workspace/uploads/shot.JPG', roots())).toMatchObject({ kind: 'photo' })
  })

  it('treats svg as a file, not a picture', () => {
    // Telegram's sendPhoto rejects it and Teams will not inline it, so
    // calling it a photo only makes the send fail.
    write(join(uploadsDir, 'diagram.svg'), '<svg/>')
    expect(resolveOutboundFile('workspace/uploads/diagram.svg', roots())).toMatchObject({ kind: 'document' })
  })

  it('refuses a path outside the project', () => {
    write(join(outside, 'elsewhere.pdf'))
    expect(resolveOutboundFile(join(outside, 'elsewhere.pdf'), roots())).toEqual({
      ok: false,
      reason: 'it is outside the project folder',
    })
  })

  it('refuses a traversal dressed as a relative path', () => {
    write(join(outside, 'secrets.txt'))
    const sneaky = join('..', '..', outside.split('/').pop()!, 'secrets.txt')
    expect(resolveOutboundFile(sneaky, roots()).ok).toBe(false)
  })

  it('refuses a symlink that points out of the project', () => {
    // Resolved before the containment check, not after: a link inside the
    // project pointing at /etc/passwd is inside the project right up until
    // someone follows it, and we are the ones following it.
    const target = write(join(outside, 'target.txt'), 'secret')
    const link = join(uploadsDir, 'innocent.txt')
    symlinkSync(target, link)
    expect(resolveOutboundFile('workspace/uploads/innocent.txt', roots())).toEqual({
      ok: false,
      reason: 'it is outside the project folder',
    })
  })

  it('refuses credential files and the assistant database by name', () => {
    for (const name of [
      '.env',
      '.env.local',
      'server.key',
      'cert.pem',
      'id_ed25519',
      'google-credentials.json',
      'assistant.db',
      'assistant.sqlite3',
      'store.db-wal',
      'api-token.txt',
      'client-secret.json',
      '.npmrc',
    ]) {
      write(join(projectRoot, name))
      const result = resolveOutboundFile(name, roots())
      expect(result.ok, `${name} should be refused`).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/credentials or private state/)
    }
  })

  it('still sends an ordinary file whose name merely mentions a safe word', () => {
    write(join(uploadsDir, 'keynote-outline.md'), '# notes')
    expect(resolveOutboundFile('workspace/uploads/keynote-outline.md', roots()).ok).toBe(true)
  })

  it('refuses a directory, an empty file and a missing one', () => {
    mkdirSync(join(uploadsDir, 'folder'))
    write(join(uploadsDir, 'blank.txt'), '')
    expect(resolveOutboundFile('workspace/uploads/folder', roots())).toEqual({ ok: false, reason: 'it is not a file' })
    expect(resolveOutboundFile('workspace/uploads/blank.txt', roots())).toEqual({ ok: false, reason: 'it is empty' })
    expect(resolveOutboundFile('workspace/uploads/ghost.txt', roots())).toEqual({ ok: false, reason: 'no such file' })
  })

  it('refuses a home-relative path rather than guessing whose home', () => {
    expect(resolveOutboundFile('~/.ssh/id_rsa', roots()).ok).toBe(false)
  })

  it('refuses a file past the read cap', () => {
    const big = join(uploadsDir, 'huge.bin')
    writeFileSync(big, Buffer.alloc(MAX_OUTBOUND_BYTES + 1))
    const result = resolveOutboundFile('workspace/uploads/huge.bin', roots())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/too big/)
  })

  it('reports the real path, so a caller never re-resolves it', () => {
    // realpathSync on the expectation too: on macOS /var is a symlink to
    // /private/var, and the resolver hands back what it actually opened.
    write(join(uploadsDir, 'chart.png'))
    const result = resolveOutboundFile('workspace/uploads/chart.png', roots())
    expect(result.ok && result.path).toBe(realpathSync(resolve(uploadsDir, 'chart.png')))
  })
})

describe('teaching an existing install the convention', () => {
  it('appends the section when CLAUDE.md has never heard of it', () => {
    const updated = ensureFileMarkerSection('# Assistant\n\nSome owner text.\n')
    expect(updated).toContain('[[file: workspace/uploads/chart.png]]')
    expect(updated).toContain('Some owner text.')
  })

  it('does nothing when the marker is already documented', () => {
    // Including when the owner wrote their own words for it: detection is by
    // the marker, not by our heading.
    expect(ensureFileMarkerSection('# Assistant\n\nSend me stuff with [[file: x]] when needed.\n')).toBeNull()
  })

  it('is idempotent across repeated updates', () => {
    const once = ensureFileMarkerSection('# Assistant\n')!
    expect(ensureFileMarkerSection(once)).toBeNull()
  })
})
