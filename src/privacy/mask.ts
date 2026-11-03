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

export function placeholderFor(e: Pick<Entry, 'id' | 'kind'>): string {
  return `${PREFIX[e.kind]}_${e.id}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One form of a name as a pattern: any case, any run of spaces between words, whole words only. */
function formPattern(form: string): string {
  const words = form.trim().split(/\s+/).map(escapeRegExp)
  const body = words.join('\\s+')
  // \b only works next to a word character; "A.C.M.E." ends in a dot.
  const start = /^\w/.test(form.trim()) ? '(?<![\\w])' : ''
  const end = /\w$/.test(form.trim()) ? '(?![\\w])' : ''
  return `${start}${body}${end}`
}

/** Email addresses and phone numbers, found without a list. */
export const EMAIL_RE = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g
// 10 to 15 digits with the usual separators, optionally +country code. Not
// dates (2026-11-03) or long ids: a dashed date has only 8 digits, and a run
// of digits with no separator at all is left alone.
export const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w])/g

/** Every email address and phone number in `text`, in order, without repeats. */
export function findContactDetails(text: string): Array<{ kind: 'email' | 'phone'; value: string }> {
  const seen = new Set<string>()
  const out: Array<{ kind: 'email' | 'phone'; value: string }> = []
  for (const [kind, re] of [['email', EMAIL_RE], ['phone', PHONE_RE]] as const) {
    for (const m of text.matchAll(re)) {
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
    this.pattern = forms.length ? new RegExp(forms.map((f) => `(${formPattern(f.form)})`).join('|'), 'gi') : null
  }

  get size(): number {
    return this.byId.size
  }

  /**
   * `text` with every listed name, email and phone swapped for its
   * placeholder. Emails and phones go first: an address like
   * jane@acme.com must become EMAIL_4 whole, not jane@COMPANY_2.com.
   */
  mask(text: string, used?: Set<number>): string {
    if (!text) return text
    let out = text
    if (this.contacts.size) {
      for (const [kind, re] of [['email', EMAIL_RE], ['phone', PHONE_RE]] as const) {
        out = out.replace(re, (m) => {
          const e = this.contacts.get(`${kind}:${normalizeContact(kind, m)}`)
          if (!e) return m
          used?.add(e.id)
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
      used?.add(this.formOwner[i].id)
      return placeholderFor(this.formOwner[i])
    })
  }

  /** True when `kind:value` is already on the list. */
  hasContact(kind: 'email' | 'phone', value: string): boolean {
    return this.contacts.has(`${kind}:${normalizeContact(kind, value)}`)
  }

  /**
   * `text` with known placeholders swapped back. `json`: the text sits
   * inside a JSON string. `allowed`: only these entries (see MaskScope).
   */
  restore(text: string, json = false, allowed?: ReadonlySet<number>): string {
    if (!text || !this.byId.size) return text
    return text.replace(PLACEHOLDER, (whole, prefix: string, id: string) => {
      const e = this.byId.get(Number(id))
      if (!e || PREFIX[e.kind] !== prefix || (allowed && !allowed.has(e.id))) return whole
      return json ? JSON.stringify(e.value).slice(1, -1) : e.value
    })
  }

  /** A restorer for text that arrives in pieces (a streamed reply). */
  stream(json = false, allowed?: ReadonlySet<number>): StreamRestorer {
    return new StreamRestorer(this, json, allowed)
  }

  /** A scope for one request and its reply. */
  scope(): MaskScope {
    return new MaskScope(this)
  }
}

/**
 * One request and its reply. Only placeholders this request's own masking
 * produced are restored, so typing "PERSON_3" in a chat and getting the model
 * to repeat it never reveals a name that chat did not already send.
 */
export class MaskScope {
  readonly used = new Set<number>()
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
}

/** What the wire formats need: a Masker, or a MaskScope for one request. */
export type Masking = Pick<MaskScope, 'mask' | 'restore' | 'stream'>

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
  constructor(private readonly masker: Masker, private readonly json: boolean, private readonly allowed?: ReadonlySet<number>) {}

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
