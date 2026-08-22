/**
 * Live validation for keys captured by the /secret chat flow.
 *
 * One cheap authenticated read per provider. The outcome contract the flow
 * depends on: 'invalid' only when the provider definitively rejected the
 * credential (401/403, or Google's API_KEY_INVALID) — that blocks the save.
 * Everything else that isn't a clean 2xx is 'unverified': the key is saved
 * anyway with a warning, because a provider outage or an unknown status must
 * never lock a client out of storing a good key.
 */

export type ValidationResult =
  | { status: 'ok' }
  | { status: 'invalid'; detail?: string }
  | { status: 'unverified'; detail?: string }

export type ValidateFn = (name: string, value: string) => Promise<ValidationResult>

interface Probe {
  url: (value: string) => string
  headers?: (value: string) => Record<string, string>
}

const PROBES: Record<string, Probe> = {
  ANTHROPIC_API_KEY: {
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (v) => ({ 'x-api-key': v, 'anthropic-version': '2023-06-01' }),
  },
  OPENAI_API_KEY: {
    url: () => 'https://api.openai.com/v1/models',
    headers: (v) => ({ Authorization: `Bearer ${v}` }),
  },
  GOOGLE_API_KEY: {
    url: (v) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}`,
  },
  ELEVENLABS_API_KEY: {
    url: () => 'https://api.elevenlabs.io/v1/user',
    headers: (v) => ({ 'xi-api-key': v }),
  },
  TELEGRAM_BOT_TOKEN: {
    url: (v) => `https://api.telegram.org/bot${v}/getMe`,
  },
}

const TIMEOUT_MS = 10_000

/** Google rejects a bad key with 400 + reason API_KEY_INVALID, not 401. */
async function isGoogleBadKey(res: Response): Promise<boolean> {
  if (res.status !== 400) return false
  try {
    return (await res.text()).includes('API_KEY_INVALID')
  } catch {
    return false
  }
}

export function createValidator(fetchImpl: typeof fetch = fetch): ValidateFn {
  return async (name, value) => {
    const probe = PROBES[name]
    if (!probe) return { status: 'unverified', detail: 'no validator for this key' }
    try {
      const res = await fetchImpl(probe.url(value), {
        headers: probe.headers?.(value),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) return { status: 'ok' }
      if (res.status === 401 || res.status === 403) {
        return { status: 'invalid', detail: `HTTP ${res.status}` }
      }
      if (name === 'GOOGLE_API_KEY' && (await isGoogleBadKey(res))) {
        return { status: 'invalid', detail: 'API_KEY_INVALID' }
      }
      return { status: 'unverified', detail: `HTTP ${res.status}` }
    } catch (err) {
      return { status: 'unverified', detail: err instanceof Error ? err.message : 'request failed' }
    }
  }
}
