/**
 * Secret scrubbing for log output.
 *
 * Two layers, because secrets leak in two ways:
 *   1. EXACT VALUES. Every value of a secret-looking env var (names ending KEY, TOKEN,
 *      SECRET, PASSWORD, PAT, CREDENTIAL, plus vault secrets registered at runtime) is
 *      replaced wherever it appears, in any format, on any line. This is the layer that
 *      catches "unusual formats" (multi-line errors, JSON dumps, URLs, base64 wrappers)
 *      because it does not care what the surrounding text looks like.
 *   2. SHAPES. Well-known token formats and `key=value` / `"key": "value"` pairs for
 *      secret-named keys, for credentials we do not know about yet.
 *
 * Pure functions only (no logger import), so the logger can depend on this and tests can
 * exercise it directly. The scrubber must never throw: logging has to keep working.
 */

const MIN_SECRET_LENGTH = 8
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIAL|CREDENTIALS)$/i
/** Object keys whose string values are always redacted in logged objects (bare `key` and `pat` are too common to blank). */
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|credentials?)$/i
const MAX_DEPTH = 6
const MAX_STRING = 200_000

export const REDACTED = '[REDACTED]'

/** Registered at runtime (vault-resolved secrets that never appear in .env). */
const runtimeSecrets = new Set<string>()

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= MIN_SECRET_LENGTH) runtimeSecrets.add(value)
}

export function secretValuesFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  for (const [name, raw] of Object.entries(env)) {
    if (!SECRET_NAME.test(name)) continue
    const v = raw?.trim()
    if (v && v.length >= MIN_SECRET_LENGTH) out.push(v)
  }
  return out
}

/** Token shapes. Order matters little; each is applied globally. */
const SHAPES: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9]{32,}/g, REDACTED],
  // Telegram bot token, bare or inside https://api.telegram.org/bot<token>/method
  [/(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, REDACTED],
  [/\bxox[bpas]-[A-Za-z0-9-]{20,}/g, REDACTED],
  [/\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  // Authorization headers: keep the scheme, drop the credential
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`],
  // key=value, key: value and "key": "value" for secret-named keys (JSON dumps, query strings, env dumps).
  // Anchored on the keyword itself with no leading wildcard, so scanning stays linear on huge strings.
  // An optional Bearer/Basic scheme word is kept so the credential after it is what gets redacted.
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|token)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?)(?!\[REDACTED\]|(?:Bearer|Basic)\b)([^"'\s,&}\]]{6,})/gi,
    `$1${REDACTED}`,
  ],
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface Scrubber {
  string(s: string): string
  deep<T>(value: T): T
}

/** Build a scrubber over a fixed set of exact secret values (plus anything registered later). */
export function createScrubber(initialSecrets: string[] = []): Scrubber {
  const fixed = [...new Set(initialSecrets.filter((v) => v.length >= MIN_SECRET_LENGTH))]
  let cacheKey = ''
  let exact: RegExp | null = null

  function exactRegex(): RegExp | null {
    const all = [...fixed, ...runtimeSecrets]
    const key = all.join('\u0000')
    if (key !== cacheKey) {
      cacheKey = key
      // Longest first so a secret that contains a shorter one is replaced whole.
      const sorted = [...new Set(all)].sort((a, b) => b.length - a.length)
      exact = sorted.length ? new RegExp(sorted.map(escapeRegExp).join('|'), 'g') : null
    }
    return exact
  }

  function string(input: string): string {
    try {
      let s = input.length > MAX_STRING ? input.slice(0, MAX_STRING) + '…[truncated]' : input
      const rx = exactRegex()
      if (rx) s = s.replace(rx, REDACTED)
      for (const [shape, repl] of SHAPES) s = s.replace(shape, repl)
      return s
    } catch {
      return REDACTED
    }
  }

  /**
   * Fail closed. Where the structural walk cannot go on (too deep, a getter that
   * throws, an odd object), serialise the value with the same rules applied as it goes:
   * secret-named keys are blanked and every string is scrubbed BEFORE JSON escapes it,
   * so a secret containing a quote or backslash still matches. Anything that still
   * cannot be serialised is dropped whole.
   */
  function flatten(value: unknown): string {
    try {
      const json = JSON.stringify(value, (key, v) => {
        if (typeof v === 'bigint') return String(v)
        if (typeof v !== 'string') return v
        return SECRET_KEY.test(key) && v.length >= 1 ? REDACTED : string(v)
      })
      return json ?? ''
    } catch {
      return REDACTED
    }
  }

  function deep<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
    let entered = false
    try {
      if (typeof value === 'string') return string(value) as unknown as T
      if (value === null || typeof value !== 'object') return value
      if (Buffer.isBuffer(value)) return value
      if (depth >= MAX_DEPTH) return flatten(value) as unknown as T
      // A cycle would otherwise hand back the raw original, which the logger then writes unscrubbed.
      if (seen.has(value as object)) return '[Circular]' as unknown as T
      seen.add(value as object)
      entered = true
      if (value instanceof Error) {
        const e = value as Error & Record<string, unknown>
        const clone = Object.create(Object.getPrototypeOf(e)) as Error & Record<string, unknown>
        for (const k of Object.getOwnPropertyNames(e)) {
          const v = e[k] // property access, not the descriptor: V8 exposes `stack` as an accessor
          clone[k] = typeof v === 'string' ? string(v) : deep(v, depth + 1, seen)
        }
        return clone as unknown as T
      }
      if (Array.isArray(value)) return value.map((v) => deep(v, depth + 1, seen)) as unknown as T
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) && typeof v === 'string' && v.length >= 1 ? REDACTED : deep(v, depth + 1, seen)
      }
      return out as T
    } catch {
      return flatten(value) as unknown as T
    } finally {
      // `seen` holds the ancestors of the value being walked, so one object shared by two
      // siblings is scrubbed both times and only a true cycle comes back as [Circular].
      if (entered) seen.delete(value as object)
    }
  }

  return { string, deep: (v) => deep(v) }
}
