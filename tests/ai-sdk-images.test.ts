/**
 * Card #249: on the ai-sdk runtime a `[Photo attached: ...]` line becomes an
 * image part, for photos inside the uploads folder only.
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_IMAGES, withAttachedImages } from '../src/runtime/ai-sdk/images.js'

const dir = mkdtempSync(join(tmpdir(), 'aisdk-images-'))
const uploads = join(dir, 'uploads')
mkdirSync(join(uploads, 'chat', 'c1'), { recursive: true })
const png = join(uploads, 'chat', 'c1', 'shot.png')
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const outside = join(dir, 'secret.png')
writeFileSync(outside, 'not for the model')

describe('withAttachedImages', () => {
  it('a photo in the uploads folder becomes an image part after the text', () => {
    const msg = `[Photo attached: ${png}]\nWhat is this?`
    const out = withAttachedImages(msg, uploads)
    expect(out).toEqual([
      { type: 'text', text: msg },
      { type: 'image', image: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
    ])
  })

  it('text with no photo line is returned unchanged', () => {
    expect(withAttachedImages('just words', uploads)).toBe('just words')
  })

  it('a photo line pointing outside the uploads folder is ignored, including through a symlink', () => {
    const link = join(uploads, 'link.png')
    symlinkSync(outside, link)
    expect(withAttachedImages(`[Photo attached: ${outside}]`, uploads)).toBe(`[Photo attached: ${outside}]`)
    expect(withAttachedImages(`[Photo attached: ${link}]`, uploads)).toBe(`[Photo attached: ${link}]`)
  })

  it('a missing file or a non-image is ignored', () => {
    const txt = join(uploads, 'a.txt')
    writeFileSync(txt, 'hi')
    expect(withAttachedImages(`[Photo attached: ${join(uploads, 'gone.png')}]`, uploads)).toBe(`[Photo attached: ${join(uploads, 'gone.png')}]`)
    expect(withAttachedImages(`[Photo attached: ${txt}]`, uploads)).toBe(`[Photo attached: ${txt}]`)
  })

  it('an image over 5 MB is not sent, and the model is told why', () => {
    const big = join(uploads, 'big.jpg')
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1))
    const out = withAttachedImages(`[Photo attached: ${big}]`, uploads)
    expect(out).toBe(`[Photo attached: ${big}]\n\n(The image at ${big} is over 5 MB, so it could not be shown to you directly.)`)
  })

  it(`at most ${MAX_IMAGES} images go with one turn`, () => {
    const lines = Array.from({ length: MAX_IMAGES + 1 }, () => `[Photo attached: ${png}]`).join('\n')
    const out = withAttachedImages(lines, uploads) as Array<{ type: string; text?: string }>
    expect(out.filter((p) => p.type === 'image')).toHaveLength(MAX_IMAGES)
    expect(out[0]!.text).toContain(`Only the first ${MAX_IMAGES} images are shown to you`)
  })
})

describe('ai-sdk runtime wiring', () => {
  it('the request carries the image; the saved session keeps only the text', async () => {
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')
    const { UPLOADS_DIR } = await import('../src/media.js')
    const { SessionStore } = await import('../src/runtime/ai-sdk/sessions.js')
    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const { rmSync } = await import('node:fs')

    const photo = join(UPLOADS_DIR, `.test-wiring-${process.pid}`, 'shot.png')
    mkdirSync(join(photo, '..'), { recursive: true })
    writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    try {
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'a chart' },
              { type: 'text-end' as const, id: 't1' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
            ],
          }),
        }),
      })
      const rows = new Map<string, string>()
      const db = {
        exec() {},
        prepare(sql: string) {
          return /SELECT/i.test(sql)
            ? { get: (id: string) => (rows.has(id) ? { messages: rows.get(id)! } : undefined) }
            : { run: (id: string, messages: string) => { rows.set(id, messages) } }
        },
      }
      const store = new SessionStore(db as any)
      const runtime = new AiSdkAgentRuntime(store, model as any)
      const message = `[Photo attached: ${photo}]\nWhat is this?`
      const result = await runtime.run({ message })
      expect(result.text).toBe('a chart')

      const sent = model.doStreamCalls[0]!.prompt as Array<{ role: string; content: unknown }>
      const user = sent.filter((m) => m.role === 'user').at(-1)!
      expect(user.content).toEqual([
        expect.objectContaining({ type: 'text', text: message }),
        expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
      ])

      const saved = store.load(result.newSessionId!)!
      expect(saved.find((m) => m.role === 'user')).toEqual({ role: 'user', content: message })
    } finally {
      rmSync(join(photo, '..'), { recursive: true, force: true })
    }
  })
})
