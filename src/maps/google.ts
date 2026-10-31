/**
 * The three Google Maps Platform calls Havn makes (card #266), and the plain
 * shapes they return. Shared by the maps proxy Worker (deploy/maps-proxy),
 * which calls Google with Havn's key for hosted boxes, and by the box's own
 * client on a self-install, which calls Google with the customer's key. So it
 * uses nothing but fetch and plain objects.
 *
 * Nothing here logs. Requests carry addresses and place names, and those must
 * never reach a log line on either side.
 */
import { microUsdFor, type MapsCall } from './pricing.js'

export type TravelMode = 'DRIVE' | 'TRANSIT' | 'WALK'
export const TRAVEL_MODES: readonly TravelMode[] = ['DRIVE', 'TRANSIT', 'WALK']

export interface LatLng { lat: number; lng: number }
/** An address or place text, or coordinates. */
export type Waypoint = string | LatLng

export interface GeocodeResult { lat: number; lng: number; address: string }
export interface RouteRequest {
  origin: Waypoint
  destination: Waypoint
  /** When the trip starts. Past or missing means now. */
  departAt?: string | Date
  /** DRIVE (default) uses live and predicted traffic. */
  mode?: TravelMode
}
export interface RouteResult {
  mode: TravelMode
  /** Travel time for that departure, with traffic when driving. */
  durationSeconds: number
  /** Travel time ignoring traffic, when Google gives one. */
  staticDurationSeconds?: number
  distanceMeters: number
}
export interface PlaceResult { id: string; name: string; address: string; lat: number; lng: number }

/** Why a call gave no answer. Callers fall back to the location alone. */
export type Unavailable =
  | 'not_configured'
  | 'unauthorized'
  | 'over_quota'
  | 'timeout'
  | 'upstream'
  | 'not_found'
  | 'bad_request'

/** What one call produced, and what Google will bill for it (0 when it never reached Google). */
export type Outcome<T> =
  | { ok: true; value: T; microUsd: number }
  | { ok: false; reason: Unavailable; microUsd: number }

export const MAX_TEXT = 300
const MAX_PLACES = 5

// --- input checks, the same on both sides -----------------------------------

export function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t && t.length <= MAX_TEXT ? t : null
}

function isLatLng(v: unknown): v is LatLng {
  const o = v as LatLng
  return !!o && typeof o === 'object' && Number.isFinite(o.lat) && Number.isFinite(o.lng) &&
    Math.abs(o.lat) <= 90 && Math.abs(o.lng) <= 180
}

export function cleanWaypoint(v: unknown): Waypoint | null {
  if (isLatLng(v)) return { lat: v.lat, lng: v.lng }
  return cleanText(v)
}

/** A route request as it arrives (from JSON or a caller), checked; null when malformed. */
export function cleanRouteRequest(v: unknown): { origin: Waypoint; destination: Waypoint; departAt?: string; mode: TravelMode } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const origin = cleanWaypoint(r.origin)
  const destination = cleanWaypoint(r.destination)
  if (!origin || !destination) return null
  const mode = r.mode === undefined ? 'DRIVE' : r.mode
  if (!TRAVEL_MODES.includes(mode as TravelMode)) return null
  let departAt: string | undefined
  if (r.departAt !== undefined && r.departAt !== null) {
    const t = r.departAt instanceof Date ? r.departAt.getTime() : typeof r.departAt === 'string' ? Date.parse(r.departAt) : NaN
    if (!Number.isFinite(t)) return null
    departAt = new Date(t).toISOString()
  }
  return { origin, destination, mode: mode as TravelMode, ...(departAt ? { departAt } : {}) }
}

// --- Google ------------------------------------------------------------------

export interface GoogleOpts {
  key: string
  fetch?: typeof fetch
  /** Per-call limit; the Worker uses less than the box's 5 seconds so its answer arrives first. */
  timeoutMs?: number
  now?: () => number
}

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText'

type Raw = { status: number; body: unknown } | { reason: Unavailable }

async function send(opts: GoogleOpts, url: string, init: RequestInit): Promise<Raw> {
  const f = opts.fetch ?? fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 4000)
  try {
    const res = await f(url, { ...init, signal })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch (err) {
    const name = (err as { name?: string })?.name
    return { reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'upstream' }
  }
}

/** A 2xx from Google is billed; anything else is not. */
function settle<T>(call: MapsCall, raw: Raw, read: (body: unknown) => T | null | 'empty'): Outcome<T> {
  if ('reason' in raw) return { ok: false, reason: raw.reason, microUsd: 0 }
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, reason: raw.status === 400 ? 'bad_request' : 'upstream', microUsd: 0 }
  }
  const microUsd = microUsdFor(call)
  const value = read(raw.body)
  if (value === 'empty') return { ok: false, reason: 'not_found', microUsd }
  if (value === null) return { ok: false, reason: 'upstream', microUsd }
  return { ok: true, value, microUsd }
}

const seconds = (d: unknown): number | undefined => {
  const m = typeof d === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d) : null
  return m ? Math.round(Number(m[1])) : undefined
}

export async function googleGeocode(text: string, opts: GoogleOpts): Promise<Outcome<GeocodeResult>> {
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(text)}&key=${encodeURIComponent(opts.key)}`
  const raw = await send(opts, url, { method: 'GET' })
  // The Geocoding API answers 200 with its own status field.
  if (!('reason' in raw) && raw.status === 200) {
    const s = (raw.body as { status?: string } | null)?.status
    if (s === 'REQUEST_DENIED' || s === 'OVER_QUERY_LIMIT' || s === 'OVER_DAILY_LIMIT' || s === 'UNKNOWN_ERROR') {
      return { ok: false, reason: 'upstream', microUsd: 0 }
    }
    if (s === 'INVALID_REQUEST') return { ok: false, reason: 'bad_request', microUsd: 0 }
  }
  return settle('geocode', raw, (body) => {
    const b = body as { status?: string; results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }> } | null
    if (b?.status === 'ZERO_RESULTS' || (b?.results && b.results.length === 0)) return 'empty'
    const first = b?.results?.[0]
    const loc = first?.geometry?.location
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null
    return { lat: loc.lat as number, lng: loc.lng as number, address: first?.formatted_address ?? '' }
  })
}

function waypoint(w: Waypoint): unknown {
  return typeof w === 'string' ? { address: w } : { location: { latLng: { latitude: w.lat, longitude: w.lng } } }
}

export async function googleRoute(req: { origin: Waypoint; destination: Waypoint; departAt?: string; mode: TravelMode }, opts: GoogleOpts): Promise<Outcome<RouteResult>> {
  const now = (opts.now ?? Date.now)()
  const body: Record<string, unknown> = {
    origin: waypoint(req.origin),
    destination: waypoint(req.destination),
    travelMode: req.mode,
  }
  // Google refuses a departure time in the past; past or missing means now.
  if (req.departAt && Date.parse(req.departAt) > now + 60_000) body.departureTime = req.departAt
  // TRAFFIC_AWARE is the Pro SKU; Google allows a routing preference for driving only.
  if (req.mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE'
  const raw = await send(opts, ROUTES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': opts.key,
      'x-goog-fieldmask': 'routes.duration,routes.staticDuration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  })
  return settle('route', raw, (b) => {
    const routes = (b as { routes?: Array<{ duration?: string; staticDuration?: string; distanceMeters?: number }> } | null)?.routes
    if (!routes || routes.length === 0) return 'empty'
    const duration = seconds(routes[0].duration)
    if (duration === undefined) return null
    const fixed = seconds(routes[0].staticDuration)
    return {
      mode: req.mode,
      durationSeconds: duration,
      ...(fixed !== undefined ? { staticDurationSeconds: fixed } : {}),
      distanceMeters: Number(routes[0].distanceMeters ?? 0),
    }
  })
}

export async function googlePlaces(text: string, opts: GoogleOpts): Promise<Outcome<PlaceResult[]>> {
  const raw = await send(opts, PLACES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': opts.key,
      'x-goog-fieldmask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: text, pageSize: MAX_PLACES }),
  })
  return settle('places', raw, (b) => {
    const places = (b as { places?: Array<{ id?: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number } }> } | null)?.places
    if (!places) return 'empty'
    const out = places.slice(0, MAX_PLACES).filter((p) => Number.isFinite(p.location?.latitude) && Number.isFinite(p.location?.longitude)).map((p) => ({
      id: p.id ?? '',
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      lat: p.location!.latitude as number,
      lng: p.location!.longitude as number,
    }))
    return out.length ? out : 'empty'
  })
}

/** Messages built from Google data must credit it (Maps Platform terms). */
export const GOOGLE_ATTRIBUTION = 'Travel data from Google Maps'
