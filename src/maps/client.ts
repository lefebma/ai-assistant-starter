/**
 * The box's maps client (card #266): geocode, route and place search behind
 * one small interface, so the feature code (#260 travel times, #261 timing
 * problems) never knows where the answer came from.
 *
 * - Hosted box: MAPS_PROXY_URL (.env) and the MAPS_PROXY_TOKEN secret point it
 *   at Havn's Worker (deploy/maps-proxy). The Google key is never on the box.
 *   Each call's cost comes back from the Worker and is added to this month's
 *   AI spend (ai-usage.json), so it counts toward the monthly allowance.
 * - Self-install: the customer's own GOOGLE_MAPS_API_KEY secret, read through
 *   the vault like every other key, calls Google directly.
 * - Neither: every call answers `not_configured`. Nothing throws.
 *
 * MAPS_PROVIDER picks the provider for the direct path (google is the only
 * one built; Mapbox is the planned fallback and plugs in as another Backend).
 * Every call gives up within 5 seconds, and any failure is a typed reason the
 * caller turns into "travel time not available" and the location alone.
 *
 * Log lines name the call and the reason only, never what was asked.
 */
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { getSecret } from '../vault/index.js'
import { recordMapsSpend } from '../ai-usage.js'
import {
  GOOGLE_ATTRIBUTION,
  cleanRouteRequest,
  cleanText,
  googleGeocode,
  googlePlaces,
  googleRoute,
  type GeocodeResult,
  type Outcome,
  type PlaceResult,
  type RouteRequest,
  type RouteResult,
  type Unavailable,
} from './google.js'
import type { MapsCall } from './pricing.js'

export type { GeocodeResult, PlaceResult, RouteRequest, RouteResult, TravelMode, Unavailable, Waypoint, LatLng } from './google.js'

export type MapsResult<T> = { ok: true; value: T } | { ok: false; reason: Unavailable }

export interface MapsUsage {
  month: string
  requests: number
  usd: number
  quota: number
}

export interface MapsClient {
  /** proxy: Havn's Worker. direct: the customer's own key. off: nothing configured. */
  readonly mode: 'proxy' | 'direct' | 'off'
  /** Credit line for any message built from these results; null when off. */
  readonly attribution: string | null
  geocode(text: string): Promise<MapsResult<GeocodeResult>>
  route(req: RouteRequest): Promise<MapsResult<RouteResult>>
  placeSearch(text: string): Promise<MapsResult<PlaceResult[]>>
  /** This box's month-to-date maps total from the Worker (proxy mode only). */
  usage(): Promise<MapsResult<MapsUsage>>
}

/** What the owner sees in place of a travel time when a call fails. */
export const TRAVEL_TIME_UNAVAILABLE = 'travel time not available'
export const MAPS_TIMEOUT_MS = 5000

export type MapsProvider = 'google' | 'mapbox'

export interface MapsConfig {
  proxyUrl?: string
  proxyToken?: string
  /** Customer's own key, self-install only. */
  googleKey?: string
  provider?: MapsProvider | string
}

export interface MapsDeps {
  fetch?: typeof fetch
  timeoutMs?: number
  /** Where proxy costs go; defaults to the box's ai-usage.json. */
  recordSpend?: (usd: number) => void
  now?: () => number
}

/** Read fresh each time, so a key set with /secret set works without a restart. */
export function mapsConfigFromEnv(): MapsConfig {
  const env = readEnvFile(['MAPS_PROXY_URL', 'MAPS_PROVIDER'])
  return {
    proxyUrl: (env.MAPS_PROXY_URL ?? process.env.MAPS_PROXY_URL ?? '').trim() || undefined,
    proxyToken: getSecret('MAPS_PROXY_TOKEN'),
    googleKey: getSecret('GOOGLE_MAPS_API_KEY'),
    provider: (env.MAPS_PROVIDER ?? process.env.MAPS_PROVIDER ?? 'google').trim().toLowerCase(),
  }
}

/** Run `p`, or give up with `timeout` once `ms` pass, whatever `p` is doing. */
async function within<T>(ms: number, p: Promise<MapsResult<T>>): Promise<MapsResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<MapsResult<T>>((done) => { timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), ms) })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

function unavailable<T>(call: string, reason: Unavailable): MapsResult<T> {
  if (reason !== 'not_found' && reason !== 'not_configured') logger.warn({ call, reason }, 'Maps call unavailable')
  return { ok: false, reason }
}

const OFF: MapsResult<never> = { ok: false, reason: 'not_configured' }

export function createMapsClient(config: MapsConfig = mapsConfigFromEnv(), deps: MapsDeps = {}): MapsClient {
  const timeoutMs = deps.timeoutMs ?? MAPS_TIMEOUT_MS
  const f = deps.fetch ?? fetch

  if (config.proxyUrl && config.proxyToken) {
    const base = config.proxyUrl.replace(/\/+$/, '')
    const token = config.proxyToken
    const record = deps.recordSpend ?? ((usd: number) => recordMapsSpend(usd))
    const ask = async <T>(call: MapsCall | 'usage', body?: unknown): Promise<MapsResult<T>> => {
      const path = call === 'usage' ? 'usage' : call
      const run = async (): Promise<MapsResult<T>> => {
        try {
          const res = await f(`${base}/v1/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          })
          const data = (await res.json().catch(() => null)) as { result?: T; usd?: number; error?: string } | null
          if (typeof data?.usd === 'number' && data.usd > 0) record(data.usd)
          if (res.ok) return call === 'usage' ? { ok: true, value: data as T } : { ok: true, value: data?.result as T }
          const reason: Unavailable =
            res.status === 401 ? 'unauthorized'
              : res.status === 429 ? 'over_quota'
                : res.status === 404 ? 'not_found'
                  : res.status === 400 ? 'bad_request'
                    : res.status === 504 ? 'timeout'
                      : 'upstream'
          return unavailable(call, reason)
        } catch (err) {
          const name = (err as { name?: string })?.name
          return unavailable(call, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'upstream')
        }
      }
      return within(timeoutMs, run())
    }
    return {
      mode: 'proxy',
      attribution: GOOGLE_ATTRIBUTION,
      async geocode(text) {
        const t = cleanText(text)
        return t ? ask('geocode', { text: t }) : { ok: false, reason: 'bad_request' }
      },
      async route(req) {
        const r = cleanRouteRequest(req)
        return r ? ask('route', r) : { ok: false, reason: 'bad_request' }
      },
      async placeSearch(text) {
        const t = cleanText(text)
        return t ? ask('places', { text: t }) : { ok: false, reason: 'bad_request' }
      },
      usage: () => ask<MapsUsage>('usage'),
    }
  }

  const backend = config.googleKey ? BACKENDS[(config.provider ?? 'google') as MapsProvider]?.(config, { fetch: f, now: deps.now }) : undefined
  if (config.googleKey && !backend) logger.warn({ provider: config.provider }, 'Maps provider not available; travel times are off')
  if (!backend) {
    return {
      mode: 'off',
      attribution: null,
      geocode: async () => OFF,
      route: async () => OFF,
      placeSearch: async () => OFF,
      usage: async () => OFF,
    }
  }

  // Self-install: the customer pays their provider directly, so nothing is metered here.
  const direct = async <T>(call: MapsCall, p: () => Promise<Outcome<T>>): Promise<MapsResult<T>> => {
    const out = await within<T>(timeoutMs, p().then((o) => (o.ok ? { ok: true as const, value: o.value } : { ok: false as const, reason: o.reason })))
    return out.ok ? out : unavailable(call, out.reason)
  }
  return {
    mode: 'direct',
    attribution: backend.attribution,
    async geocode(text) {
      const t = cleanText(text)
      return t ? direct('geocode', () => backend.geocode(t, timeoutMs)) : { ok: false, reason: 'bad_request' }
    },
    async route(req) {
      const r = cleanRouteRequest(req)
      return r ? direct('route', () => backend.route(r, timeoutMs)) : { ok: false, reason: 'bad_request' }
    },
    async placeSearch(text) {
      const t = cleanText(text)
      return t ? direct('places', () => backend.places(t, timeoutMs)) : { ok: false, reason: 'bad_request' }
    },
    usage: async () => OFF,
  }
}

/** One maps provider for the direct path. Mapbox goes here when it is needed. */
interface Backend {
  attribution: string
  geocode(text: string, timeoutMs: number): Promise<Outcome<GeocodeResult>>
  route(req: NonNullable<ReturnType<typeof cleanRouteRequest>>, timeoutMs: number): Promise<Outcome<RouteResult>>
  places(text: string, timeoutMs: number): Promise<Outcome<PlaceResult[]>>
}

const BACKENDS: Partial<Record<MapsProvider, (c: MapsConfig, d: { fetch: typeof fetch; now?: () => number }) => Backend>> = {
  google: (c, d) => {
    const opts = (timeoutMs: number) => ({ key: c.googleKey!, fetch: d.fetch, timeoutMs, now: d.now })
    return {
      attribution: GOOGLE_ATTRIBUTION,
      geocode: (t, ms) => googleGeocode(t, opts(ms)),
      route: (r, ms) => googleRoute(r, opts(ms)),
      places: (t, ms) => googlePlaces(t, opts(ms)),
    }
  },
}
