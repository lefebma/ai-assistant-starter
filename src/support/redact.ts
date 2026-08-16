/**
 * Redaction pass for support-request diagnostics.
 *
 * Hard privacy rule: nothing that leaves the machine in a support email may
 * contain secrets or personal identifiers scraped from logs. This pass is
 * deliberately over-eager — a mangled log line is a nuisance, a leaked token
 * is an incident. It never sees .env contents at all (diagnostics.ts does not
 * read them); this is the belt on top of those suspenders for whatever a log
 * line happens to echo.
 */

/** KEY=value / "key": "value" style secrets. The key name survives (useful
 * for debugging), the value does not. */
const KEY_VALUE_RE =
  /([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential|bearer|auth)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(["']?)[^\s"',;]+/gi

/** Authorization headers: "Bearer eyJ..." / "Basic dXNlcjpwYXNz". */
const AUTH_SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Token shapes that are dangerous on their own, no key= prefix required. */
const TOKEN_SHAPE_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}/g, // OpenAI / Anthropic-style secret keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack bot/user tokens
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /\bAIza[A-Za-z0-9_-]{30,}/g, // Google API keys
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g, // JWTs
  /\b[0-9a-f]{32,}\b/gi, // long hex blobs (session ids, raw keys)
]

/** Email addresses harvested from logs are personal data; strip them all.
 * The support destination itself lives in the draft header, not the log tail. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Strip anything secret-shaped or personal from a log excerpt.
 * Order matters: key=value first (so the value is gone before the looser
 * shape rules run), then auth schemes, then bare token shapes, then emails.
 */
export function redactSensitive(text: string): string {
  let out = text
  out = out.replace(
    KEY_VALUE_RE,
    (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}[redacted]`
  )
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} [redacted]`)
  for (const re of TOKEN_SHAPE_RES) out = out.replace(re, '[redacted]')
  out = out.replace(EMAIL_RE, '[email redacted]')
  return out
}
