import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { downloadToUploads, UPLOADS_DIR } from '../src/media.js'

describe('downloadToUploads', () => {
  it('saves the body under the uploads dir with a sanitised, timestamped name', async () => {
    const seen: Array<{ url: string; headers: unknown }> = []
    const path = await downloadToUploads(
      'https://files.example/contract.pdf?sig=abc',
      'my contract (final).pdf',
      { Authorization: 'Bearer t' },
      async (url, init) => {
        seen.push({ url, headers: init?.headers })
        return new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 })
      }
    )
    expect(path.startsWith(UPLOADS_DIR)).toBe(true)
    expect(basename(path)).toMatch(/^\d+_my-contract--final-\.pdf$/)
    expect(readFileSync(path, 'utf-8')).toBe('%PDF-1.4 fake')
    expect(seen[0]).toEqual({ url: 'https://files.example/contract.pdf?sig=abc', headers: { Authorization: 'Bearer t' } })
    rmSync(path)
    expect(existsSync(path)).toBe(false)
  })

  it('throws on a non-2xx response and writes nothing', async () => {
    await expect(
      downloadToUploads('https://files.example/x.png', 'x.png', undefined, async () => new Response('nope', { status: 403 }))
    ).rejects.toThrow(/403/)
  })
})
