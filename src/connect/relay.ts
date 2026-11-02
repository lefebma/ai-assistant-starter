/**
 * Sign-in relay (connect.gethavn.ai). Runs as a Worker-style fetch handler, so
 * it has no Node-only dependencies beyond node:crypto (available on Workers
 * with nodejs_compat).
 *
 * Why it exists: Google forbids wildcard redirect addresses and a hosted box
 * cannot receive a redirect on its own, so every box shares this one address.
 *
 * Guarantees:
 *  - Any OAuth client secret lives here only (closed over by the providers).
 *    Microsoft needs none: the Havn app is a public client and the code is
 *    bound to the sign-in by PKCE instead.
 *  - Every sign-in uses PKCE (S256). The verifier is derived from the signing
 *    secret and the state's box and nonce, so the relay keeps nothing between
 *    /start and /callback and the verifier never travels in a URL.
 *  - State is signed, names the box, expires in 10 minutes, and works once.
 *  - The hand-off goes only to the origin the box registry lists for the box
 *    named in the state (never to a URL taken from the request), only over
 *    https, signed with that box's hand-off key.
 *  - Renewal (POST /refresh): a box sends its own refresh token, signed with
 *    its hand-off key, and gets a fresh access token back in the answer. This
 *    is how Gmail renews without the Web client's secret leaving the relay.
 *  - No token is stored. The only thing kept is the key of a used state, until
 *    it could no longer verify anyway. The log line records that a hand-off happened and
 *    never contains a token or a code.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { signState, verifyState, type UsedStore } from './state.js'

export interface ProviderTokens {
  account: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface RenewedTokens {
  accessToken: string
  expiresAt: number
  /** Present only when the provider rotated it. */
  refreshToken?: string
}

export interface RelayProvider {
  /** `codeChallenge` is the S256 PKCE challenge for this sign-in. */
  authUrl(state: string, redirectUri: string, codeChallenge: string): string
  exchange(code: string, redirectUri: string, codeVerifier: string): Promise<ProviderTokens>
  /** Only providers whose renewal needs the relay's client secret have this. */
  refresh?(refreshToken: string): Promise<RenewedTokens>
}

/** The provider no longer honours this refresh token (revoked, expired, password changed). */
export class GrantRevokedError extends Error {
  constructor() {
    super('invalid_grant')
  }
}

export interface BoxRecord {
  /** https origin the hand-off is posted to. */
  origin: string
  /** Shared with that box only. Signs the hand-off body. */
  handoffKey: string
}

export interface RelayOpts {
  publicUrl: string
  signingSecret: string
  boxes: { get(id: string): BoxRecord | undefined | Promise<BoxRecord | undefined> }
  providers: Record<string, RelayProvider>
  used: UsedStore
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (entry: Record<string, unknown>) => void
}

export const HANDOFF_PATH = '/connect/handoff'
export const SIGNATURE_HEADER = 'x-connect-signature'
export const REFRESH_PATH = '/refresh'
/** A signed renewal request older or newer than this is refused. */
export const REFRESH_SKEW_MS = 5 * 60_000
const MAX_REFRESH_BODY = 16 * 1024

export function signHandoff(key: string, body: string): string {
  return createHmac('sha256', key).update(body).digest('hex')
}

/** PKCE verifier for one sign-in: 43 base64url characters, never sent anywhere but the token endpoint. */
export function pkceVerifier(signingSecret: string, box: string, nonce: string): string {
  return createHmac('sha256', signingSecret).update(`pkce:${box}:${nonce}`).digest('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

const page = (status: number, msg: string) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem"><p>${msg}</p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })

export function createRelay(opts: RelayOpts) {
  const now = opts.now ?? Date.now
  const doFetch = opts.fetchImpl ?? fetch
  const log = opts.log ?? (() => {})
  const redirectUri = `${opts.publicUrl.replace(/\/$/, '')}/callback`

  async function start(url: URL): Promise<Response> {
    const provider = url.searchParams.get('provider') ?? ''
    const box = url.searchParams.get('box') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const p = Object.hasOwn(opts.providers, provider) ? opts.providers[provider] : undefined
    if (!p || !(await opts.boxes.get(box)) || nonce.length < 16 || nonce.length > 128) {
      return page(400, 'This sign-in link is not valid. Ask your assistant for a new one.')
    }
    const state = signState(opts.signingSecret, { box, provider, nonce }, now())
    const challenge = pkceChallenge(pkceVerifier(opts.signingSecret, box, nonce))
    return new Response(null, { status: 302, headers: { location: p.authUrl(state, redirectUri, challenge), 'cache-control': 'no-store' } })
  }

  async function callback(url: URL): Promise<Response> {
    const state = url.searchParams.get('state') ?? ''
    // Verify (and consume) first, so even a denial or a replay spends the state.
    const v = await verifyState(opts.signingSecret, state, opts.used, now())
    if (!v.ok) {
      log({ event: 'refused', reason: v.reason })
      return page(400, 'This sign-in link has expired or was already used. Ask your assistant for a new one.')
    }
    const { box, provider, nonce } = v.payload
    if (url.searchParams.get('error') || !url.searchParams.get('code')) {
      log({ event: 'denied', box, provider })
      return page(400, 'Sign-in was not completed. Nothing was connected.')
    }
    const rec = await opts.boxes.get(box)
    const p = Object.hasOwn(opts.providers, provider) ? opts.providers[provider] : undefined
    if (!rec || !p || !rec.origin.startsWith('https://')) {
      log({ event: 'handoff_failed', box, provider, reason: 'box_unreachable_or_insecure' })
      return page(502, 'Could not reach your assistant. Ask it for a new link.')
    }
    try {
      const tokens = await p.exchange(url.searchParams.get('code')!, redirectUri, pkceVerifier(opts.signingSecret, box, nonce))
      const body = JSON.stringify({ nonce, provider, ts: now(), ...tokens })
      const res = await doFetch(`${rec.origin}${HANDOFF_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signHandoff(rec.handoffKey, body) },
        body,
        redirect: 'error',
      })
      if (!res.ok) throw new Error(`box answered ${res.status}`)
      log({ event: 'handoff', box, provider, ok: true })
      return page(200, 'Connected. You can close this tab and go back to your chat.')
    } catch (err) {
      // Message only: never the error object, which could echo a request body.
      log({ event: 'handoff_failed', box, provider, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' })
      return page(502, 'Could not finish connecting. Ask your assistant for a new link.')
    }
  }

  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  async function refresh(req: Request): Promise<Response> {
    const raw = await req.text()
    if (raw.length > MAX_REFRESH_BODY) return answer(413, { error: 'too_large' })
    let b: Record<string, unknown>
    try {
      b = JSON.parse(raw)
    } catch {
      return answer(400, { error: 'bad_request' })
    }
    const { box, provider, refreshToken, ts } = b
    if (typeof box !== 'string' || typeof provider !== 'string' || typeof refreshToken !== 'string' || typeof ts !== 'number') {
      return answer(400, { error: 'bad_request' })
    }
    const rec = await opts.boxes.get(box)
    const sig = req.headers.get(SIGNATURE_HEADER) ?? ''
    const got = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0)
    const want = rec ? createHmac('sha256', rec.handoffKey).update(raw).digest() : Buffer.alloc(32)
    if (!rec || got.length !== want.length || !timingSafeEqual(got, want)) {
      log({ event: 'refresh_refused', reason: 'signature' })
      return answer(401, { error: 'unauthorized' })
    }
    if (Math.abs(now() - ts) > REFRESH_SKEW_MS) {
      log({ event: 'refresh_refused', box, reason: 'stale' })
      return answer(401, { error: 'stale' })
    }
    const p = Object.hasOwn(opts.providers, provider) ? opts.providers[provider] : undefined
    if (!p?.refresh) return answer(400, { error: 'no_refresh_for_provider' })
    try {
      const t = await p.refresh(refreshToken)
      log({ event: 'refresh', box, provider, ok: true })
      return answer(200, t)
    } catch (err) {
      if (err instanceof GrantRevokedError) {
        log({ event: 'refresh_failed', box, provider, reason: 'invalid_grant' })
        return answer(401, { error: 'invalid_grant' })
      }
      log({ event: 'refresh_failed', box, provider, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' })
      return answer(502, { error: 'provider_unavailable' })
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url)
      if (req.method === 'POST' && url.pathname === REFRESH_PATH) return refresh(req)
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
      if (url.pathname === '/start') return start(url)
      if (url.pathname === '/callback') return callback(url)
      return new Response('not found', { status: 404 })
    },
  }
}
