/**
 * The real name model end to end (card #275). Downloads about 109 MB the first
 * time, so it only runs with RUN_MODEL_TESTS=1.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterFinds, mergeTags } from '../src/privacy/finder/detect.js'
import { loadBertNer } from '../src/privacy/finder/model.js'

describe.skipIf(process.env['RUN_MODEL_TESTS'] !== '1')('the real name model', () => {
  it('finds a person and a company', async () => {
    const tag = await loadBertNer(process.env['MODEL_CACHE_DIR'] ?? join(tmpdir(), 'havn-models'))
    const text = 'Remind me to call Devon Spencer at Southtel Communications Inc. tomorrow.'
    const finds = filterFinds(mergeTags(text, await tag(text)), new Set())
    expect(finds.map((f) => [f.kind, f.value])).toEqual([
      ['person', 'Devon Spencer'],
      ['company', 'Southtel Communications Inc'],
    ])
    await tag.dispose?.()
  }, 120_000)
})
