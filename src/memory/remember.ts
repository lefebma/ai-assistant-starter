/**
 * Topic memories (card #276).
 *
 * When the owner states a fact worth keeping, the reply ends with a
 * [[remember: topic | fact]] marker. The bot strips it, saves the fact, and
 * tags the rows its turn saved with the topic. A newer owner fact on a topic
 * retires the older rows on it: they are kept, never recalled. That is how
 * "reminders go to Priya" stops coming back once "send them to billing@" is
 * said.
 *
 * Trust comes from the turn, never from the marker. A marker in a turn that
 * read mail, the web, a file or a forwarded message is saved as untrusted: it
 * never retires anything, and it is left out of recall while the owner has a
 * live memory on its topic. The worst a planted marker can do is pick a topic
 * nobody else uses, and then it is recalled inside the untrusted wrapper as
 * before.
 */
import { cleanTopic, extractDecisionMarkers } from './decisions.js'
import { defang } from './provenance.js'

export const MAX_FACT_LEN = 300
const MAX_REMEMBERS_PER_REPLY = 5

export type RememberMarker = { topic: string | null; text: string }

/** Told on chat turns, beside the decision instruction. */
export const REMEMBER_INSTRUCTION =
  'When the owner states a fact worth keeping for later (a contact, an amount, a date, a standing rule), end your ' +
  'reply with [[remember: short topic | the fact in one sentence]]. Use the same topic whenever a fact is about the ' +
  'same thing, so the newer fact replaces the older one; when a remembered fact in memory already has a topic in ' +
  'brackets that fits, reuse it exactly. When your reply passes on a fact from an email, web page, file, tool result ' +
  'or forwarded message, tag it the same way: it is saved as unverified and never replaces what the owner said. ' +
  'The owner never sees the marker.'

// Ends at the first ]], so a fact may hold a single bracket: [[remember: t | use the [internal] channel]].
const MARKER = /\[\[remember:\s*([\s\S]*?)\]\]/gi

function cleanFact(text: string): string {
  const t = defang(text).replace(/\s+/g, ' ').trim()
  return t.length > MAX_FACT_LEN ? t.slice(0, MAX_FACT_LEN - 3).trimEnd() + '...' : t
}

/** Take the [[remember: ...]] markers out of a reply. */
export function extractRememberMarkers(text: string): { cleanText: string; remembers: RememberMarker[] } {
  const remembers: RememberMarker[] = []
  const stripped = text.replace(MARKER, (_m, body: string) => {
    const bar = body.indexOf('|')
    const topic = bar >= 0 ? cleanTopic(body.slice(0, bar)) : null
    const fact = cleanFact(bar >= 0 ? body.slice(bar + 1) : body)
    if (fact && remembers.length < MAX_REMEMBERS_PER_REPLY) remembers.push({ topic, text: fact })
    return ''
  })
  return { cleanText: stripped === text ? text : stripped.replace(/\n{3,}/g, '\n\n').trim(), remembers }
}

/**
 * Every marker a chat reply can carry: decision proposals and facts to
 * remember. What the owner sees is cleanText.
 */
export function extractReplyMarkers(text: string): {
  cleanText: string
  proposals: Array<{ topic: string | null; text: string }>
  remembers: RememberMarker[]
} {
  const { cleanText: noDecisions, proposals } = extractDecisionMarkers(text)
  const { cleanText, remembers } = extractRememberMarkers(noDecisions)
  return { cleanText, proposals, remembers }
}

/** How a remembered fact is stored, and recalled. The topic shows so the model can reuse it. */
export function factContent(m: RememberMarker): string {
  return m.topic ? `Remembered fact [${m.topic}]: ${m.text}` : `Remembered fact: ${m.text}`
}

/**
 * A streamed preview without markers, complete or half-written, any kind
 * (remember, decision, buttons, file): the final reply strips or renders them.
 * An unfinished opening ("[[remem") is held back too.
 */
export function hidePartialMarkers(text: string): string {
  return text.replace(/\[\[[a-z]+:[\s\S]*?(?:\]\]|$)/gi, '').replace(/\[\[[a-z]*$|\[$/i, '')
}

/**
 * Only [[remember:]] markers, complete or half-written, for surfaces that
 * never get the instruction but deliver the agent's text as is (scheduled
 * results, the cockpit, voice). Other markers there keep their old handling.
 */
export function hideRememberMarkers(text: string): string {
  return text
    .replace(/\[\[remember:[\s\S]*?(?:\]\]|$)/gi, '')
    .replace(/\[\[(?:r(?:e(?:m(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?)?$/i, '')
}

const IDENTIFIER = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s)\]]+|[$€£]?[\w,.-]*\d[\w,.-]*/g
const FILLER = new Set('that this with from have will they them their there what when where which would could should about into your than then also just only been were here more most some such very each other after before every always never'.split(' '))
// Words that turn a statement around: "never to Priya" is not "to Priya",
// and "billing@ instead of ap@" is not "ap@".
const NEGATION = /\b(?:not|no|never|don'?t|doesn'?t|isn'?t|won'?t|can'?t|cannot|stop|without|nobody|none|longer|anymore|formerly|previously|replaced?|retired|old)\b/i
// "instead of" and "rather than" mark what follows as the old one ("billing@ instead" is the new one).
const REPLACED_BY = /\b(?:instead\s+of|rather\s+than)\b/i

function norm(s: string): string {
  return s.toLowerCase().replace(/^[^\w$€£@]+|[^\w@]+$/g, '')
}

/** The addresses, links and numbers in a text, normalised, each with whether a negation sits within a few words of it. */
function identifiers(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const m of text.matchAll(IDENTIFIER)) {
    const t = norm(m[0])
    if (!/\d|@|:\/\//.test(t)) continue
    const before = text.slice(0, m.index).split(/\s+/).slice(-4).join(' ')
    // After it, only the same clause: "billing@, never to Priya" says nothing against billing@.
    const after = text.slice(m.index! + m[0].length).split(/[,.;:!?\n]/)[0]!.split(/\s+/).slice(0, 5).join(' ')
    out.set(t, (out.get(t) ?? false) || NEGATION.test(before) || REPLACED_BY.test(before) || NEGATION.test(after))
  }
  return out
}

/**
 * True when the owner's own words in the turn back a fact the reply tagged.
 * Every address, link and number in the fact must be one the owner typed,
 * exactly, and negated or contrasted the same way in its clause ("never to
 * priya@", "instead of priya@" and "priya@ is no longer" do not back "to
 * priya@"). A fact with none of those needs each of its clauses
 * to match one of the owner's: half its words (four letters or more) and the
 * same negation. When in doubt it is not: an unbacked fact is
 * still saved, it just retires nothing.
 */
export function backedByOwner(fact: string, ownerText: string): boolean {
  const stems = (t: string) => t.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !FILLER.has(w)).map((w) => w.slice(0, 5))
  const ids = identifiers(fact)
  if (ids.size) {
    const own = identifiers(ownerText)
    if (![...ids].every(([t, negated]) => own.has(t) && own.get(t) === negated)) return false
    // A fact that turns something around where the owner never did is not theirs.
    return !NEGATION.test(fact.replace(IDENTIFIER, ' ')) || NEGATION.test(ownerText)
  }
  // Clause by clause: each clause of the fact needs a clause of the owner's
  // with half its words and the same negation, so "send to Priya, never to
  // Bob" backs neither "never send to Priya" nor "send to Bob".
  // Names count in any length here ("never to Bob"), unlike the half-the-words test.
  const names = (t: string) => t.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 2 && !FILLER.has(w)).map((w) => w.slice(0, 5))
  const clauses = (t: string) =>
    t.split(/[,.;:!?\n]|\b(?:but|except|although|however)\b/i)
      .map((c) => ({ words: [...new Set(stems(c))], names: new Set(names(c)), negated: NEGATION.test(c) || REPLACED_BY.test(c) }))
  const ownAll = clauses(ownerText)
  // A bare "No." or "Not anymore." turns round what came before it: when in doubt, not backed.
  if (ownAll.some((o) => o.negated && !o.words.length)) return false
  const factClauses = clauses(fact).filter((c) => c.words.length)
  if (!factClauses.length) return false
  const ownClauses = ownAll.filter((c) => c.words.length || c.names.size)
  return factClauses.every((f) => {
    const same = ownClauses.filter((o) => o.negated === f.negated)
    // A word the owner used only the other way round ("never to Oakridge", "never to Bob") turns the clause against them.
    const flipped = [...f.names].some(
      (w) => !same.some((o) => o.names.has(w)) && ownClauses.some((o) => o.names.has(w)),
    )
    return !flipped && same.some((o) => f.words.filter((w) => o.words.includes(w)).length * 2 >= f.words.length)
  })
}
