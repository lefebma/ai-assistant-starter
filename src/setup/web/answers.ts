/**
 * The web setup asks for far less than the terminal wizard: who you are,
 * your messaging app, and how the assistant reaches a model. Everything else
 * gets the answer the wizard would get from someone who skipped the optional
 * questions (no email yet, no optional skills, no monthly audit). Email comes
 * later through the connectors, and keys through /secret in chat.
 */
import { buildEmailSignature, type AiProvider, type Answers, type EngineChoice } from '../plan.js'
import { PERSONALITY_PRESETS } from '../wizard.js'
import type { Fetch } from './telegram.js'

export interface WebProfile {
  ownerName: string
  assistantName: string
  timezone: string
  city: string
  /** Index into PERSONALITY_PRESETS. */
  vibe: number
  ownerBio: string
}

export interface WebEngine {
  kind: EngineChoice
  provider?: AiProvider
  model?: string
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: '',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro',
}

export class InputError extends Error {}

function text(raw: Record<string, unknown>, key: string, max: number, required: boolean): string {
  const v = typeof raw[key] === 'string' ? (raw[key] as string).trim() : ''
  if (required && !v) throw new InputError(`Please fill in ${key === 'ownerName' ? 'your name' : key === 'assistantName' ? "your assistant's name" : key}.`)
  if (v.length > max) throw new InputError(`That ${key} is too long.`)
  // No control characters: these end up in markdown and .env.
  if (/[\u0000-\u001f\u007f]/.test(v.replace(/\n/g, ''))) throw new InputError(`That ${key} has characters it cannot use.`)
  return v
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)
  } catch {
    return false
  }
}

export function parseProfile(input: unknown): WebProfile {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const timezone = text(raw, 'timezone', 64, true)
  if (!isTimezone(timezone)) throw new InputError(`"${timezone}" is not a timezone this computer knows.`)
  const vibe = Number(raw['vibe'])
  // These three are substituted raw into skill manifests, which are JSON.
  const plain = (key: string, max: number, required: boolean): string => {
    const v = text(raw, key, max, required).replace(/\n/g, ' ')
    if (/["\\]/.test(v)) throw new InputError('Please leave out quotation marks and backslashes.')
    return v
  }
  return {
    ownerName: plain('ownerName', 80, true),
    assistantName: plain('assistantName', 40, true),
    timezone,
    city: plain('city', 80, false),
    vibe: Number.isInteger(vibe) && vibe >= 0 && vibe < PERSONALITY_PRESETS.length ? vibe : 1,
    ownerBio: text(raw, 'ownerBio', 600, false),
  }
}

export function parseEngine(input: unknown, subscriptionAllowed: boolean): WebEngine & { key: string } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const kind = raw['kind']
  if (kind === 'subscription') {
    if (!subscriptionAllowed) throw new InputError('A Claude subscription sign-in is not available on this install. Use an API key.')
    return { kind: 'subscription', key: '' }
  }
  if (kind === 'later') return { kind: 'later', key: '' }
  if (kind !== 'api-key') throw new InputError('Choose how your assistant reaches an AI model.')
  const provider = raw['provider']
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'google') throw new InputError('Choose whose API key this is.')
  const key = typeof raw['key'] === 'string' ? raw['key'].trim() : ''
  if (!/^[A-Za-z0-9_\-.]{20,256}$/.test(key)) throw new InputError('That API key does not look right. Copy it again, the whole key.')
  const model = typeof raw['model'] === 'string' && raw['model'].trim() ? raw['model'].trim() : DEFAULT_MODELS[provider]
  if (model && !/^[A-Za-z0-9._:\-/]{1,80}$/.test(model)) throw new InputError('That model name does not look right.')
  return { kind: 'api-key', provider, model, key }
}

export interface Place {
  latitude: string
  longitude: string
  tempUnit: 'celsius' | 'fahrenheit'
  /** The name the lookup matched, e.g. "Toronto, Ontario, Canada". */
  label: string
}

const FAHRENHEIT = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW'])

/**
 * Coordinates for the weather skill, so nobody is asked for a latitude.
 * Open-Meteo is the service the weather skill already calls, and only the
 * city name is sent. Null when it cannot say; the caller falls back.
 */
export async function lookUpCity(f: Fetch, city: string): Promise<Place | null> {
  if (!city) return null
  try {
    const res = await f(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(city)}`, {
      signal: AbortSignal.timeout(5000),
    })
    const body = (await res.json()) as { results?: Array<{ latitude: number; longitude: number; country_code?: string; name: string; admin1?: string; country?: string }> }
    const r = body.results?.[0]
    if (!r) return null
    return {
      latitude: r.latitude.toFixed(2),
      longitude: r.longitude.toFixed(2),
      tempUnit: FAHRENHEIT.has((r.country_code ?? '').toUpperCase()) ? 'fahrenheit' : 'celsius',
      label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    }
  } catch {
    return null
  }
}

/** The wizard's Answers for a web setup. Secrets are deliberately absent: they go to the vault. */
export function answersFromWeb(profile: WebProfile, engine: WebEngine, place: Place | null, projectPath: string): Answers {
  return {
    ownerName: profile.ownerName,
    assistantName: profile.assistantName,
    timezone: profile.timezone,
    city: profile.city || place?.label || '',
    platform: 'Telegram',
    engine: engine.kind,
    ...(engine.kind === 'api-key' ? { aiProvider: engine.provider, aiModel: engine.model ?? '' } : {}),
    personalityVibe: PERSONALITY_PRESETS[profile.vibe] ?? PERSONALITY_PRESETS[1]!,
    ownerBio: profile.ownerBio,
    emailProvider: 'Skip for now',
    emailAddress: '',
    gmailAddress: '',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: buildEmailSignature({ name: profile.ownerName, title: '', phone: '', email: '' }),
    // The wizard's own defaults when the city lookup fails.
    latitude: place?.latitude ?? '40.71',
    longitude: place?.longitude ?? '-74.01',
    tempUnit: place?.tempUnit ?? 'celsius',
    monthlyAudit: false,
    skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    keys: {},
    projectPath,
  }
}
