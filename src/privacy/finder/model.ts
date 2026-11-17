/**
 * The name model for the privacy finder (card #275): a small English
 * name-recognition model run in this process, on the CPU. What it reads never
 * leaves the machine. The only network call is the one-time model download,
 * which carries no message text.
 *
 * It loads on first use and is let go after ten idle minutes, so a 2 GB box
 * only carries it while there is something to read. If it cannot load (no
 * network, not enough memory), the finder turns itself off until the next
 * restart; chat is never affected.
 */
import { logger } from '../../logger.js'
import type { TokenTag } from './detect.js'

export type Tagger = ((text: string) => Promise<TokenTag[]>) & { dispose?: () => Promise<void> | void }

export const MODEL_ID = 'Xenova/bert-base-NER'
export const IDLE_MS = 10 * 60_000

export interface ModelTagger {
  /** The model's tags for `text`, or none when the finder is off. */
  tag: (text: string) => Promise<TokenTag[]>
  disabled: () => boolean
  unloadIfIdle: () => void
}

export function createModelTagger(opts: { load: () => Promise<Tagger>; idleMs?: number; now?: () => number }): ModelTagger {
  const idleMs = opts.idleMs ?? IDLE_MS
  const now = opts.now ?? Date.now
  let model: Tagger | null = null
  let loading: Promise<Tagger | null> | null = null
  let off = false
  let lastUse = 0

  const get = async (): Promise<Tagger | null> => {
    if (model) return model
    if (off) return null
    loading ??= opts
      .load()
      .then((m) => {
        model = m
        return m
      })
      .catch((err: unknown) => {
        off = true
        logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Privacy name finder: the name model could not load, so the finder is off until restart')
        return null
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  return {
    tag: async (text) => {
      const m = await get()
      if (!m) return []
      lastUse = now()
      return m(text)
    },
    disabled: () => off,
    unloadIfIdle: () => {
      if (!model || now() - lastUse < idleMs) return
      const m = model
      model = null
      void Promise.resolve(m.dispose?.()).catch(() => undefined)
    },
  }
}

/** The real model. Imported lazily so a box that never uses the finder never loads the runtime. */
export async function loadBertNer(cacheDir: string): Promise<Tagger> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = cacheDir
  const ner = await pipeline('token-classification', MODEL_ID, { dtype: 'q8' })
  const tagger: Tagger = async (text) => (await ner(text)) as unknown as TokenTag[]
  tagger.dispose = () => ner.dispose()
  return tagger
}
