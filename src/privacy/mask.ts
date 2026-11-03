/**
 * The anonymizer's engine (card #187): swap real names for placeholders on
 * the way out to a public model, and swap them back on the way in.
 *
 * Pure: no store, no network. The list of names comes from store.ts; the
 * two places that talk to a model (proxy.ts for the Claude CLI, middleware.ts
 * for the ai-sdk runtime) call mask() on what they send and restore() on what
 * comes back.
 *
 * Placeholders look like PERSON_3 or COMPANY_12: the kind and the entry's id.
 * Models copy tokens of that shape exactly, and ordinary writing never
 * contains them, so restoring never touches the owner's own words. The id
 * never changes, so the same name always gets the same placeholder and a
 * conversation stays consistent from turn to turn.
 */

export const KINDS = ['person', 'company', 'email', 'phone', 'other'] as const
export type Kind = (typeof KINDS)[number]

export type Entry = {
  id: number
  kind: Kind
  /** What the owner wrote, and what a reply gets back. */
  value: string
  /** Other ways the same name is written ("Acme" for "Acme Corporation"). They restore as `value`. */
  aliases: string[]
}

const PREFIX: Record<Kind, string> = { person: 'PERSON', company: 'COMPANY', email: 'EMAIL', phone: 'PHONE', other: 'NAME' }
const PREFIXES = Object.values(PREFIX)
const PLACEHOLDER = new RegExp(`\\b(${PREFIXES.join('|')})_(\\d+)\\b`, 'g')

/**
 * Sent with every private request. Without it a model may notice the
 * placeholders and ask for the real names, which defeats the point.
 */
export const PRIVACY_NOTE =
  'Privacy: some names, companies, email addresses and phone numbers in this conversation have been replaced with placeholders such as PERSON_1, COMPANY_2, EMAIL_3 or PHONE_4, before anything reached you. They stand for the real details, which the user sees in your reply. Use each placeholder exactly as written wherever you would use the real detail, including in tool calls. Never ask for the real name, never guess it, and never mention that placeholders are in use.'

/** A file type whose bytes are text, so its names can be masked like any other text. */
export function isTextMedia(mediaType: unknown): boolean {
  return typeof mediaType === 'string' && /^(text\/|application\/(json|xml|csv|x-ndjson|yaml|x-yaml|markdown)\b)|\+(json|xml)\b/i.test(mediaType)
}

/** Apply `f` to the text in base64 `data`, and encode the result the same way. */
export function mapBase64Text(data: string, f: (s: string) => string): string {
  return Buffer.from(f(Buffer.from(data, 'base64').toString('utf8')), 'utf8').toString('base64')
}

export function placeholderFor(e: Pick<Entry, 'id' | 'kind'>): string {
  return `${PREFIX[e.kind]}_${e.id}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Letters and digits in any script: a name ends where these stop.
const WORD = '[\\p{L}\\p{M}\\p{N}_]'
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{M}\p{N}_]/u.test(c)

/**
 * One form of a name as a pattern: any case, any run of spaces between
 * words, straight or curly apostrophes, any dash, whole words only. Forms
 * and text are both compared in composed Unicode (NFC), so an accented name
 * typed or stored either way still matches.
 */
function formPattern(form: string): string {
  const words = form.normalize('NFC').trim().split(/\s+/).map((w) =>
    escapeRegExp(w).replace(/['\u2018\u2019]/g, "['\u2018\u2019]").replace(/[-\u2010\u2011\u2013\u2014]/g, '[-\u2010\u2011\u2013\u2014]'),
  )
  const body = words.join('\\s+')
  const t = form.trim()
  const start = isWordChar(t[0]) ? `(?<!${WORD})` : ''
  const end = isWordChar(t[t.length - 1]) ? `(?!${WORD})` : ''
  return `${start}${body}${end}`
}

/** Email addresses and phone numbers, found without a list. */
export const EMAIL_RE = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g
// A North American number with the usual separators (optionally +1), or any
// number written with a + country code (8 to 15 digits in groups). Not dates
// (2026-11-03) or ids: a run of digits with no + and no separators is left
// alone, so a bare 4165551234 is not caught (docs/PRIVACY.md says so).
export const PHONE_RE = /(?<![\w+])(?:(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}|\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,6})(?![\w])/g

/** A phone match with a plausible number of digits. */
function phoneOk(m: string): boolean {
  const n = m.replace(/\D/g, '').length
  return n >= 8 && n <= 15
}

/** Every email address and phone number in `text`, in order, without repeats. */
export function findContactDetails(text: string): Array<{ kind: 'email' | 'phone'; value: string }> {
  const seen = new Set<string>()
  const out: Array<{ kind: 'email' | 'phone'; value: string }> = []
  for (const [kind, re] of [['email', EMAIL_RE], ['phone', PHONE_RE]] as const) {
    for (const m of text.normalize('NFC').matchAll(re)) {
      if (kind === 'phone' && !phoneOk(m[0])) continue
      const key = `${kind}:${normalizeContact(kind, m[0])}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind, value: m[0] })
    }
  }
  return out
}

/** The form two spellings of one email or phone share: lower case, digits only. */
export function normalizeContact(kind: 'email' | 'phone', value: string): string {
  return kind === 'email' ? value.trim().toLowerCase() : value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
}

export class Masker {
  private readonly byId = new Map<number, Entry>()
  private readonly pattern: RegExp | null
  private readonly formOwner: Entry[]
  private readonly contacts = new Map<string, Entry>()

  constructor(entries: Entry[]) {
    const forms: Array<{ form: string; entry: Entry }> = []
    for (const e of entries) {
      this.byId.set(e.id, e)
      // Emails and phones are found by shape, so any spelling of one matches.
      if (e.kind === 'email' || e.kind === 'phone') {
        for (const form of [e.value, ...e.aliases]) this.contacts.set(`${e.kind}:${normalizeContact(e.kind, form)}`, e)
        continue
      }
      for (const form of [e.value, ...e.aliases]) {
        if (form.trim()) forms.push({ form: form.trim(), entry: e })
      }
    }
    // Longest first, so "Acme Corporation" wins over "Acme".
    forms.sort((a, b) => b.form.length - a.form.length)
    this.formOwner = forms.map((f) => f.entry)
    this.pattern = forms.length ? new RegExp(forms.map((f) => `(${formPattern(f.form)})`).join('|'), 'giu') : null
  }

  get size(): number {
    return this.byId.size
  }

  /**
   * `text` with every listed name, email and phone swapped for its
   * placeholder. Emails and phones go first: an address like
   * jane@acme.com must become EMAIL_4 whole, not jane@COMPANY_2.com.
   */
  mask(text: string, used?: Map<number, string>): string {
    if (!text) return text
    let out = text.normalize('NFC')
    if (this.contacts.size) {
      for (const [kind, re] of [['email', EMAIL_RE], ['phone', PHONE_RE]] as const) {
        out = out.replace(re, (m) => {
          if (kind === 'phone' && !phoneOk(m)) return m
          const e = this.contacts.get(`${kind}:${normalizeContact(kind, m)}`)
          if (!e) return m
          seen(used, e.id, m)
          return placeholderFor(e)
        })
      }
    }
    if (!this.pattern) return out
    return out.replace(this.pattern, (...args) => {
      // The first group that matched names the form (groups are in sorted order).
      const groups = args.slice(1, 1 + this.formOwner.length) as Array<string | undefined>
      const i = groups.findIndex((g) => g !== undefined)
      if (i < 0) return args[0]
      seen(used, this.formOwner[i].id, args[0] as string)
      return placeholderFor(this.formOwner[i])
    })
  }

  /** True when `text` holds anything on the list. */
  matches(text: string): boolean {
    return !!text && this.mask(text) !== text.normalize('NFC')
  }

  /** True when `kind:value` is already on the list. */
  hasContact(kind: 'email' | 'phone', value: string): boolean {
    return this.contacts.has(`${kind}:${normalizeContact(kind, value)}`)
  }

  /**
   * `text` with known placeholders swapped back. `json`: the text sits
   * inside a JSON string. `allowed`: only these entries, each back to the
   * words that were masked (see MaskScope).
   */
  restore(text: string, json = false, allowed?: ReadonlyMap<number, string>): string {
    if (!text || !this.byId.size) return text
    return text.replace(PLACEHOLDER, (whole, prefix: string, id: string) => {
      const e = this.byId.get(Number(id))
      if (!e || PREFIX[e.kind] !== prefix) return whole
      const value = allowed ? allowed.get(e.id) : e.value
      if (value === undefined) return whole
      return json ? JSON.stringify(value).slice(1, -1) : value
    })
  }

  /** A restorer for text that arrives in pieces (a streamed reply). */
  stream(json = false, allowed?: ReadonlyMap<number, string>): StreamRestorer {
    return new StreamRestorer(this, json, allowed)
  }

  /** A scope for one request and its reply. */
  scope(): MaskScope {
    return new MaskScope(this)
  }
}

/** Note the words masked as entry `id`, keeping the longest spelling seen. */
function seen(used: Map<number, string> | undefined, id: number, words: string): void {
  if (!used) return
  const had = used.get(id)
  if (had === undefined || words.length > had.length) used.set(id, words)
}

/**
 * One request and its reply. A placeholder is restored only if this
 * request's own masking produced it, and back to the words the request
 * contained. So a chat that types "PERSON_3", or only ever says "Acme",
 * never gets back a name or a fuller spelling it did not send.
 */
export class MaskScope {
  readonly used = new Map<number, string>()
  constructor(private readonly masker: Masker) {}
  mask(text: string): string {
    return this.masker.mask(text, this.used)
  }
  restore(text: string, json = false): string {
    return this.masker.restore(text, json, this.used)
  }
  stream(json = false): StreamRestorer {
    return this.masker.stream(json, this.used)
  }
  matches(text: string): boolean {
    return this.masker.matches(text)
  }
}

/**
 * A request that cannot go out filtered: the AI's own signed reasoning in
 * the current step holds a listed name (it was written before the name was
 * added, or before the filter was on). It cannot be changed or left out.
 */
export class PrivacyRefusal extends Error {
  constructor() {
    super('This step cannot continue with the privacy filter on: the AI\'s earlier reasoning in it mentions a name on the list. Send the request again to start a fresh step.')
    this.name = 'PrivacyRefusal'
  }
}

/** What the wire formats need: a Masker, or a MaskScope for one request. */
export type Masking = Pick<MaskScope, 'mask' | 'restore' | 'stream' | 'matches'>

/**
 * The longest tail of `text` that could still grow into a placeholder:
 * "PERS", "COMPANY_", "PHONE_4" (more digits may follow). Empty when none.
 */
export function pendingTail(text: string): string {
  const m = /[A-Z][A-Z_]*\d*$/.exec(text)
  if (!m) return ''
  // A placeholder starts a word.
  if (m.index > 0 && /\w/.test(text[m.index - 1])) return ''
  const tail = m[0]
  const under = tail.indexOf('_')
  if (under < 0) return PREFIXES.some((p) => p.startsWith(tail)) ? tail : ''
  const prefix = tail.slice(0, under)
  const rest = tail.slice(under + 1)
  return PREFIXES.includes(prefix) && /^\d*$/.test(rest) ? tail : ''
}

/**
 * Restores a reply that arrives in pieces. A placeholder can be split across
 * two pieces ("PERSON_" then "3"), so the end of each piece that could still
 * become one is held back until the next piece (or flush) settles it.
 */
export class StreamRestorer {
  private held = ''
  constructor(private readonly masker: Masker, private readonly json: boolean, private readonly allowed?: ReadonlyMap<number, string>) {}

  /** The restored text that is safe to pass on now. */
  push(piece: string): string {
    const text = this.held + piece
    const tail = pendingTail(text)
    this.held = tail
    return this.masker.restore(text.slice(0, text.length - tail.length), this.json, this.allowed)
  }

  /** Whatever is still held, restored. Call once the piece stream ends. */
  flush(): string {
    const out = this.masker.restore(this.held, this.json, this.allowed)
    this.held = ''
    return out
  }
}
