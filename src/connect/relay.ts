/**
 * Sign-in relay (connect.gethavn.ai). Runs as a Worker-style fetch handler, so
 * it has no Node-only dependencies beyond node:crypto (available on Workers
 * with nodejs_compat) and WebCrypto.
 *
 * Why it exists: Google forbids wildcard redirect addresses and a hosted box
 * cannot receive a redirect on its own, so every box shares this one address.
 *
 * Guarantees:
 *  - Any OAuth client secret lives here only (closed over by the providers).
 *    Microsoft needs none: the Havn app is a public client and the code is
 *    bound to the sign-in by PKCE instead.
 *  - A sign-in link opens a page naming the assistant it connects to, and only
 *    a click on that page goes on to the provider. The click sets a short-lived
 *    cookie in that browser and the state carries its hash; /callback refuses
 *    a state whose cookie is not in the browser that comes back. So a provider
 *    link minted by someone else (a script can fake the click's headers) fails
 *    in the victim's browser: whoever signs in must have seen the page.
 *  - Every sign-in uses PKCE (S256). The verifier is derived from the signing
 *    secret and the state's box and nonce, so the relay keeps nothing between
 *    /start and /callback and the verifier never travels in a URL.
 *  - State is signed, names the box, expires in 10 minutes, and works once.
 *  - The hand-off goes only to the origin the box registry lists for the box
 *    named in the state (never to a URL taken from the request), only over
 *    https, signed with that box's hand-off key.
 *  - Renewal (POST /refresh) and revocation (POST /revoke), for providers
 *    whose renewal needs the relay's client secret (Gmail): the refresh token
 *    the box holds is sealed to that box (AES-GCM, the box and provider as
 *    associated data). It is useless outside the relay, and the relay renews
 *    or revokes it only for the box it was sealed to, on a request signed with
 *    that box's hand-off key.
 *  - No token is stored. The only thing kept is the key of a used state, until
 *    it could no longer verify anyway. Log lines record what happened and
 *    never contain a token or a code.
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
  /** Shown on the confirmation page: "Continue to Google". */
  label: string
  /** Origin the provider's sign-in page lives on, for the page's form-action policy. */
  authOrigin: string
  /** `codeChallenge` is the S256 PKCE challenge for this sign-in. */
  authUrl(state: string, redirectUri: string, codeChallenge: string): string
  exchange(code: string, redirectUri: string, codeVerifier: string): Promise<ProviderTokens>
  /** Only providers whose renewal needs the relay's client secret have these. */
  refresh?(refreshToken: string): Promise<RenewedTokens>
  revoke?(refreshToken: string): Promise<void>
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
  /** Shown to the person signing in, e.g. "Marc's assistant". */
  label?: string
}

export interface RelayOpts {
  publicUrl: string
  signingSecret: string
  /** Seals refresh tokens to their box. */
  sealingSecret: string
  /** Earlier sealing secrets, still accepted for opening (renewals reseal with the current one). */
  oldSealingSecrets?: string[]
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
export const REVOKE_PATH = '/revoke'
/** A signed renewal request older or newer than this is refused. */
export const REFRESH_SKEW_MS = 5 * 60_000
const MAX_BODY = 16 * 1024

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

// --- sealing ------------------------------------------------------------------

const SEAL_PREFIX = 's1.'

async function sealKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('relay sealing secret must be at least 32 characters')
  const raw = createHash('sha256').update(`seal:${secret}`).digest()
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Seals a refresh token to one box and provider. */
export async function seal(secret: string, box: string, provider: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${box}:${provider}`) },
    await sealKey(secret),
    new TextEncoder().encode(token),
  )
  return SEAL_PREFIX + Buffer.concat([Buffer.from(iv), Buffer.from(ct)]).toString('base64url')
}

/** Opens with the current secret, then any older ones; `stale` says it needs resealing. */
async function unsealAny(secrets: string[], box: string, provider: string, sealed: string): Promise<{ token: string; stale: boolean } | null> {
  for (let i = 0; i < secrets.length; i++) {
    const token = await unseal(secrets[i], box, provider, sealed)
    if (token !== null) return { token, stale: i > 0 }
  }
  return null
}

/** The token, or null if it was not sealed by this relay for this box and provider. */
export async function unseal(secret: string, box: string, provider: string, sealed: string): Promise<string | null> {
  if (!sealed.startsWith(SEAL_PREFIX)) return null
  const buf = Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64url')
  if (buf.length < 12 + 16) return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: new TextEncoder().encode(`${box}:${provider}`) },
      await sealKey(secret),
      buf.subarray(12),
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

// --- pages ---------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function html(status: number, body: string, formAction = "'none'", referrer = 'no-referrer'): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Havn</title>` +
      `<body style="font-family:sans-serif;padding:2rem;max-width:32rem;line-height:1.5">${body}`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The confirmation page needs same-origin: under no-referrer a browser
        // sends `Origin: null` on the form POST, and the click would be refused.
        'referrer-policy': referrer,
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        // form-action also governs every redirect after the POST in Chromium, and
        // providers hop on (Microsoft to login.live.com or a company's own sign-in),
        // so the confirmation page allows any https target. Nothing on it is
        // user-controlled markup, so that loses nothing.
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`,
      },
    },
  )
}

const page = (status: number, msg: string) => html(status, `<p>${esc(msg)}</p>`)

const BIND_COOKIE = (provider: string) => `__Host-havn-connect-${provider}`

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

const sha = (v: string) => createHash('sha256').update(v).digest('base64url')

/** Reads a body up to `max` bytes, or null if it is longer (checked before and while reading). */
export async function readCapped(req: Request, max = MAX_BODY): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createRelay(opts: RelayOpts) {
  const now = opts.now ?? Date.now
  const doFetch = opts.fetchImpl ?? fetch
  const log = opts.log ?? (() => {})
  const base = opts.publicUrl.replace(/\/$/, '')
  const relayOrigin = new URL(base).origin
  const redirectUri = `${base}/callback`
  const providerOf = (name: string) => (Object.hasOwn(opts.providers, name) ? opts.providers[name] : undefined)
  const notValid = () => page(400, 'This sign-in link is not valid. Ask your assistant for a new one.')

  async function checkStart(provider: string, box: string, nonce: string) {
    const p = providerOf(provider)
    const rec = p && nonce.length >= 16 && nonce.length <= 128 ? await opts.boxes.get(box) : undefined
    return p && rec ? { p, rec } : null
  }

  /** GET /start: the confirmation page. Never redirects. */
  async function confirm(url: URL): Promise<Response> {
    const provider = url.searchParams.get('provider') ?? ''
    const box = url.searchParams.get('box') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const ok = await checkStart(provider, box, nonce)
    if (!ok) return notValid()
    const who = esc(ok.rec.label || box)
    const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`
    return html(
      200,
      `<h1 style="font-size:1.3rem">Connect your ${esc(ok.p.label)} mail and calendar</h1>` +
        `<p>This gives <strong>${who}</strong> access to read and send your email and manage your calendar.</p>` +
        `<p><strong>Only continue if you asked your own assistant for this link just now.</strong> ` +
        `If someone sent it to you, close this page. Continuing would give them your mail.</p>` +
        `<form method="post" action="/start">${hidden('provider', provider)}${hidden('box', box)}${hidden('nonce', nonce)}` +
        `<button type="submit" style="font-size:1rem;padding:.6rem 1.2rem">Continue to ${esc(ok.p.label)}</button></form>`,
      "'self' https:",
      'same-origin',
    )
  }

  /** POST /start: the click on the confirmation page, and only that, goes on to the provider. */
  async function go(req: Request): Promise<Response> {
    // A forwarded link is a GET; a form on another site carries its own Origin;
    // the page cannot be framed. So this only passes for a click on our page.
    const origin = req.headers.get('origin')
    const site = req.headers.get('sec-fetch-site')
    if (origin !== relayOrigin || (site !== null && site !== 'same-origin')) {
      log({ event: 'start_refused', reason: 'cross_site' })
      return notValid()
    }
    const raw = await readCapped(req, 2048)
    if (raw === null) return notValid()
    const f = new URLSearchParams(raw)
    const provider = f.get('provider') ?? ''
    const box = f.get('box') ?? ''
    const nonce = f.get('nonce') ?? ''
    const ok = await checkStart(provider, box, nonce)
    if (!ok) return notValid()
    // Binds the sign-in to this browser. SameSite=Lax still rides the top-level
    // navigation back from the provider.
    const cookie = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const state = signState(opts.signingSecret, { box, provider, nonce, bind: sha(cookie) }, now())
    const challenge = pkceChallenge(pkceVerifier(opts.signingSecret, box, nonce))
    return new Response(null, {
      status: 303,
      headers: {
        location: ok.p.authUrl(state, redirectUri, challenge),
        'cache-control': 'no-store',
        'set-cookie': `${BIND_COOKIE(provider)}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      },
    })
  }

  async function callback(req: Request, url: URL): Promise<Response> {
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
    const cookie = cookieValue(req, BIND_COOKIE(provider))
    const want = v.payload.bind ? Buffer.from(v.payload.bind) : Buffer.alloc(0)
    const got = cookie ? Buffer.from(sha(cookie)) : Buffer.alloc(0)
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) {
      log({ event: 'refused', box, provider, reason: 'other_browser' })
      return page(400, 'This sign-in has to finish in the browser where you pressed Continue. Ask your assistant for a new link and open it on this device.')
    }
    const rec = await opts.boxes.get(box)
    const p = providerOf(provider)
    if (!rec || !p || !rec.origin.startsWith('https://')) {
      log({ event: 'handoff_failed', box, provider, reason: 'box_unreachable_or_insecure' })
      return page(502, 'Could not reach your assistant. Ask it for a new link.')
    }
    try {
      const tokens = await p.exchange(url.searchParams.get('code')!, redirectUri, pkceVerifier(opts.signingSecret, box, nonce))
      // A token only the relay can renew leaves here sealed to this box.
      if (p.refresh) tokens.refreshToken = await seal(opts.sealingSecret, box, provider, tokens.refreshToken)
      const body = JSON.stringify({ nonce, provider, ts: now(), ...tokens })
      const res = await doFetch(`${rec.origin}${HANDOFF_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signHandoff(rec.handoffKey, body) },
        body,
        redirect: 'error',
      })
      if (!res.ok) throw new Error(`box answered ${res.status}`)
      log({ event: 'handoff', box, provider, ok: true })
      const done = page(200, `Connected to ${rec.label || box}. You can close this tab and go back to your chat.`)
      done.headers.append('set-cookie', `${BIND_COOKIE(provider)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`)
      return done
    } catch (err) {
      // Message only: never the error object, which could echo a request body.
      log({ event: 'handoff_failed', box, provider, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' })
      return page(502, 'Could not finish connecting. Ask your assistant for a new link.')
    }
  }

  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  /**
   * Shared by /refresh and /revoke: a body {box, provider, refreshToken, ts}
   * signed with that box's hand-off key, recent, for a provider the relay
   * renews, carrying a token sealed to that same box.
   */
  async function boxRequest(req: Request, event: string): Promise<{ box: string; provider: string; p: RelayProvider; token: string; stale: boolean } | Response> {
    const raw = await readCapped(req)
    if (raw === null) return answer(413, { error: 'too_large' })
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
      log({ event: `${event}_refused`, reason: 'signature' })
      return answer(401, { error: 'unauthorized' })
    }
    if (Math.abs(now() - ts) > REFRESH_SKEW_MS) {
      log({ event: `${event}_refused`, box, reason: 'stale' })
      return answer(401, { error: 'stale' })
    }
    const p = providerOf(provider)
    if (!p?.refresh) return answer(400, { error: 'no_refresh_for_provider' })
    const opened = await unsealAny([opts.sealingSecret, ...(opts.oldSealingSecrets ?? [])], box, provider, refreshToken)
    if (opened === null) {
      log({ event: `${event}_refused`, box, provider, reason: 'not_sealed_for_box' })
      return answer(401, { error: 'not_yours' })
    }
    return { box, provider, p, token: opened.token, stale: opened.stale }
  }

  async function refresh(req: Request): Promise<Response> {
    const r = await boxRequest(req, 'refresh')
    if (r instanceof Response) return r
    try {
      const t = await r.p.refresh!(r.token)
      const out: RenewedTokens = { accessToken: t.accessToken, expiresAt: t.expiresAt }
      // Reseal a rotated token, and one still sealed with a retired secret.
      const keep = t.refreshToken ?? (r.stale ? r.token : undefined)
      if (keep) out.refreshToken = await seal(opts.sealingSecret, r.box, r.provider, keep)
      log({ event: 'refresh', box: r.box, provider: r.provider, ok: true })
      return answer(200, out)
    } catch (err) {
      if (err instanceof GrantRevokedError) {
        log({ event: 'refresh_failed', box: r.box, provider: r.provider, reason: 'invalid_grant' })
        return answer(401, { error: 'invalid_grant' })
      }
      log({ event: 'refresh_failed', box: r.box, provider: r.provider, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' })
      return answer(502, { error: 'provider_unavailable' })
    }
  }

  async function revoke(req: Request): Promise<Response> {
    const r = await boxRequest(req, 'revoke')
    if (r instanceof Response) return r
    if (!r.p.revoke) return answer(400, { error: 'no_revoke_for_provider' })
    try {
      await r.p.revoke(r.token)
      log({ event: 'revoke', box: r.box, provider: r.provider, ok: true })
      return answer(200, { ok: true })
    } catch (err) {
      log({ event: 'revoke_failed', box: r.box, provider: r.provider, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' })
      return answer(502, { error: 'provider_unavailable' })
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url)
      if (req.method === 'POST') {
        if (url.pathname === REFRESH_PATH) return refresh(req)
        if (url.pathname === REVOKE_PATH) return revoke(req)
        if (url.pathname === '/start') return go(req)
        return new Response('not found', { status: 404 })
      }
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
      if (url.pathname === '/start') return confirm(url)
      if (url.pathname === '/callback') return callback(req, url)
      return new Response('not found', { status: 404 })
    },
  }
}
