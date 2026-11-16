/**
 * Turning the name model's word-piece tags into whole names (card #275).
 *
 * The model tags word pieces ("South", "##tel") without positions, and
 * sometimes leaves the tail of a word untagged ("R", "##udd" for "Ruddy").
 * So the pieces are placed back in the text in order, each tagged word is
 * taken whole, and neighbouring words of the same kind become one name.
 */

/** One token from the transformers.js token-classification pipeline. */
export type TokenTag = { entity: string; word: string; score: number; index: number }

export type Found = { kind: 'person' | 'company'; value: string; score: number }

/** Names that are almost never a client and would only fill the owner's chat with questions. */
export const KNOWN_BRANDS = [
  'Google', 'Microsoft', 'Apple', 'Amazon', 'Meta', 'Facebook', 'Instagram', 'WhatsApp', 'Telegram', 'Slack',
  'Zoom', 'Teams', 'Outlook', 'Gmail', 'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'Gemini', 'Havn',
  'LinkedIn', 'YouTube', 'Netflix', 'Uber', 'PayPal', 'Stripe', 'Shopify', 'QuickBooks', 'Dropbox', 'Notion',
]
const BRANDS = new Set(KNOWN_BRANDS.map((b) => b.toLowerCase()))

export const MIN_SCORE = 0.8
const MIN_CHARS = 3

const KIND: Record<string, Found['kind']> = { PER: 'person', ORG: 'company' }
const WORD = /[^\s,;:!?()"[\]{}<>]+/g

type Word = { start: number; end: number; type: string; begins: boolean; scores: number[] }

function cleanValue(raw: string): string {
  return raw
    .replace(/['’]s$/i, '')
    .replace(/[.'"’]+$/, '')
    .trim()
}

/** Whole names in `text`, from the model's tags. Kinds other than person and company are dropped. */
export function mergeTags(text: string, tags: TokenTag[]): Found[] {
  const words: Array<{ start: number; end: number }> = []
  for (const m of text.matchAll(WORD)) words.push({ start: m.index!, end: m.index! + m[0].length })

  const tagged = new Map<number, Word>()
  let cursor = 0
  for (const tag of [...tags].sort((a, b) => a.index - b.index)) {
    const piece = tag.word.replace(/^##/, '')
    if (!piece || piece === '[UNK]') continue
    const at = text.indexOf(piece, cursor)
    if (at < 0) continue
    cursor = at + piece.length
    const wi = words.findIndex((w) => at >= w.start && at < w.end)
    if (wi < 0) continue
    const [prefix, type = ''] = tag.entity.includes('-') ? tag.entity.split('-', 2) : ['', tag.entity]
    const w = tagged.get(wi)
    if (w) w.scores.push(tag.score)
    else tagged.set(wi, { ...words[wi]!, type, begins: prefix === 'B', scores: [tag.score] })
  }

  const out: Found[] = []
  let group: { type: string; start: number; end: number; scores: number[]; last: number } | null = null
  const flush = (): void => {
    if (!group) return
    const kind = KIND[group.type]
    const value = cleanValue(text.slice(group.start, group.end))
    if (kind && value) out.push({ kind, value, score: group.scores.reduce((a, b) => a + b, 0) / group.scores.length })
    group = null
  }
  for (const wi of [...tagged.keys()].sort((a, b) => a - b)) {
    const w = tagged.get(wi)!
    const joins =
      group !== null &&
      group.type === w.type &&
      !w.begins &&
      group.last === wi - 1 &&
      /^ +$/.test(text.slice(group.end, w.start))
    if (joins && group) {
      group.end = w.end
      group.scores.push(...w.scores)
      group.last = wi
    } else {
      flush()
      group = { type: w.type, start: w.start, end: w.end, scores: [...w.scores], last: wi }
    }
  }
  flush()
  return out
}

/** The finds worth asking the owner about. `skip` holds lowercased names never to offer. */
export function filterFinds(finds: Found[], skip: Set<string>): Found[] {
  return finds.filter((f) => {
    if (f.score < MIN_SCORE) return false
    if (f.value.length < MIN_CHARS) return false
    const lower = f.value.toLowerCase()
    if (BRANDS.has(lower) || skip.has(lower)) return false
    if (f.kind === 'person' && f.value.split(/\s+/).length < 2) return false
    return true
  })
}
