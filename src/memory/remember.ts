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

const MARKER = /\[\[remember:\s*([^\]]+)\]\]/gi

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

/** A streamed preview without markers, complete or half-written (same rule as the web page). */
export function hidePartialMarkers(text: string): string {
  return text.replace(/\[\[[a-z]+:[^\]]*(\]\])?/gi, '').replace(/\[\[?$/, '')
}
