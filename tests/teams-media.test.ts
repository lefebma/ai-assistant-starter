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

  it('rejects up front on a declared Content-Length over the cap, writing nothing', async () => {
    await expect(
      downloadToUploads(
        'https://files.example/huge.bin',
        'huge.bin',
        undefined,
        async () => new Response('x', { status: 200, headers: { 'Content-Length': String(60 * 1024 * 1024) } })
      )
    ).rejects.toThrow(/too large/)
  })

  it('stops reading the body once the streamed size exceeds the cap, without draining the whole response', async () => {
    const CHUNK_BYTES = 10 * 1024 * 1024 // 10MB
    const TOTAL_CHUNKS = 20 // 200MB if fully drained
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls > TOTAL_CHUNKS) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(CHUNK_BYTES))
      },
    })
    await expect(
      downloadToUploads(
        'https://files.example/big.bin',
        'big.bin',
        undefined,
        async () => new Response(body, { status: 200 }),
        50 * 1024 * 1024
      )
    ).rejects.toThrow(/too large/)
    // 50MB cap / 10MB chunks: exceeded partway through the 6th pull, nowhere
    // near draining all 20 (200MB) the old arrayBuffer()-first code would
    // have buffered in full before ever checking the size.
    expect(pulls).toBeLessThan(10)
  })

  it('rejects an oversized body against an explicit maxBytes even without a Content-Length hint', async () => {
    await expect(
      downloadToUploads(
        'https://files.example/small-cap.bin',
        'small-cap.bin',
        undefined,
        async () => new Response('12345', { status: 200 }),
        4
      )
    ).rejects.toThrow(/too large/)
  })
})
