/** The name model's lazy loader (card #275). The real model is never loaded here. */
import { describe, expect, it, vi } from 'vitest'
import { createModelTagger, type Tagger } from '../src/privacy/finder/model.js'

const tags = [{ entity: 'B-ORG', word: 'Acme', score: 0.99, index: 1 }]

describe('createModelTagger', () => {
  it('loads once and reuses the model', async () => {
    const inner: Tagger = vi.fn(async () => tags)
    const load = vi.fn(async () => inner)
    const m = createModelTagger({ load })
    await m.tag('Acme')
    await m.tag('Acme again')
    expect(load).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('shares one load between calls that arrive together', async () => {
    const load = vi.fn(async () => (async () => tags) as Tagger)
    const m = createModelTagger({ load })
    await Promise.all([m.tag('a'), m.tag('b'), m.tag('c')])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('turns itself off when the model cannot load, and never tries again', async () => {
    const load = vi.fn(async (): Promise<Tagger> => {
      throw new Error('ENOTFOUND huggingface.co')
    })
    const m = createModelTagger({ load })
    expect(await m.tag('Acme')).toEqual([])
    expect(m.disabled()).toBe(true)
    expect(await m.tag('Acme')).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('lets the model go after ten idle minutes and loads it again when needed', async () => {
    let now = 0
    const load = vi.fn(async () => (async () => tags) as Tagger)
    const m = createModelTagger({ load, now: () => now })
    await m.tag('Acme')
    now = 599_999
    m.unloadIfIdle()
    await m.tag('Acme')
    expect(load).toHaveBeenCalledTimes(1)
    now += 600_000
    m.unloadIfIdle()
    await m.tag('Acme')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
