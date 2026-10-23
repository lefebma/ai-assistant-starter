/**
 * The web setup server (cards #211-#213). It runs instead of the assistant on
 * a box that has not been set up yet, on the port the assistant will use, and
 * exits once setup is done so the assistant can start in its place. After
 * that, /setup is simply a path the assistant does not serve: a 404.
 *
 * Two modes:
 * - local: bound to 127.0.0.1, answers only requests addressed to localhost
 *   (so a web page elsewhere cannot reach it through DNS rebinding) and never
 *   anything that came through a proxy.
 * - hosted: reached through the box's HTTPS edge, and only with the one-time
 *   link's token (src/setup/web/link.ts).
 *
 * Secrets typed into the page go straight into the vault. They are never
 * logged, never written to .env, and never sent back to the page.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { writeConfiguration } from '../finalize.js'
import { isManagedAi } from '../../ai-limit.js'
import type { AiProvider } from '../plan.js'
import { answersFromWeb, InputError, parseEngine, type WebEngine, parseTimezone, provisionalProfile } from './answers.js'
import { checkLink, completeLink, FailureLimiter, type LinkStore } from './link.js'
import { checkBotToken, Pairing, sendMessage, TelegramError, type BotInfo, type Fetch } from './telegram.js'

export type SetupMode = 'local' | 'hosted'

export interface ClaudeSignIn {
  /** Whether a Claude subscription sign-in can run on this machine at all. */
  available: boolean
  signedIn(): boolean
  /** Starts the browser sign-in; the page polls signedIn(). */
  start(): void
}

export interface SetupDeps {
  mode: SetupMode
  projectRoot: string
  home: string
  fetch: Fetch
  vault: { set(name: string, value: string): void }
  links: LinkStore
  now: () => number
  /** The page, with {{NONCE}} where the CSP nonce goes. */
  page: () => string
  claude?: ClaudeSignIn
  /** Runs after the finish response has been sent. */
  onFinished: () => void
  /** Pairing poll length; tests shorten it. */
  pollSeconds?: number
}

const KEY_NAME: Record<AiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
}

const MAX_BODY = 16 * 1024
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function baseHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
  // The page URL carries the setup token; never let it leave in a Referer.
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  baseHeaders(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse): void {
  baseHeaders(res)
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    // A JSON content type cannot be sent cross-site without a preflight this
    // server never answers, which is what makes these POSTs safe from CSRF.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      reject(new InputError('Expected JSON.'))
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new InputError('Too much data.'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
        resolveBody(v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
      } catch {
        reject(new InputError('Expected JSON.'))
      }
    })
    req.on('error', reject)
  })
}

const EXPIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup link expired</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>This setup link has expired</h1><p>Setup links last 48 hours. Ask whoever is setting up your assistant to send you a new one.</p></body>`

export function createSetupServer(deps: SetupDeps): Server {
  const limiter = new FailureLimiter()
  let bot: { token: string; info: BotInfo } | null = null
  let pairing: Pairing | null = null
  let finishing = false
  let finished = false

  /** Read each time: the operator marks a box managed while setup is waiting. */
  const managed = () => isManagedAi(resolve(deps.projectRoot, 'store'))

  const subscriptionAllowed = deps.mode === 'local' && !!deps.claude?.available

  /** Returns true when the request may proceed; otherwise it has been answered. */
  function admit(req: IncomingMessage, res: ServerResponse, url: URL, isPage: boolean): boolean {
    if (finished) {
      notFound(res)
      return false
    }
    if (deps.mode === 'local') {
      if (req.headers['x-forwarded-for'] || !LOCAL_HOSTS.test(req.headers.host ?? '')) {
        notFound(res)
        return false
      }
      return true
    }
    const now = deps.now()
    const auth = req.headers.authorization ?? ''
    const token = isPage ? url.searchParams.get('token') : auth.startsWith('Bearer ') ? auth.slice(7) : null
    // The real token is checked first, so a flood of bad ones cannot lock
    // the client out. Caddy puts the caller in X-Forwarded-For.
    const verdict = checkLink(deps.links, token, now)
    if (verdict === 'ok') return true
    if (verdict === 'expired') {
      if (isPage) {
        baseHeaders(res)
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(EXPIRED_PAGE)
      } else json(res, 410, { error: 'This setup link has expired. Ask for a new one.' })
      return false
    }
    const client = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() || 'direct'
    if (limiter.blocked(client, now)) {
      json(res, 429, { error: 'Too many attempts. Wait a few minutes.' })
      return false
    }
    limiter.record(client, now)
    notFound(res)
    return false
  }

  function servePage(res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64')
    baseHeaders(res)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    })
    res.end(deps.page().replaceAll('{{NONCE}}', nonce))
  }

  function pairingView(): Record<string, unknown> {
    if (!pairing) return { state: 'none' }
    const s = pairing.state
    if (s.kind === 'found' || s.kind === 'paired') return { state: s.kind, name: s.candidate.name, username: s.candidate.username ?? null }
    if (s.kind === 'error') return { state: 'error', error: s.message }
    return { state: s.kind }
  }

  async function finish(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    if (finishing) {
      json(res, 409, { error: 'Setup is already finishing.' })
      return
    }
    if (!bot || pairing?.state.kind !== 'paired') {
      json(res, 400, { error: 'Connect Telegram first.' })
      return
    }
    // A managed box has no AI step: whatever the request carries is ignored,
    // and no provider key from it ever reaches the vault.
    const engine: WebEngine & { key: string } = managed()
      ? { kind: 'managed', key: '' }
      : parseEngine(body['engine'], subscriptionAllowed)
    if (engine.kind === 'subscription' && !deps.claude?.signedIn()) {
      json(res, 400, { error: 'Sign in to Claude first, or choose an API key.' })
      return
    }
    if (existsSync(resolve(deps.projectRoot, '.env'))) {
      json(res, 409, { error: 'This assistant is already set up. To change settings, ask your assistant in chat.' })
      return
    }
    finishing = true
    // Snapshot: a token POST while the welcome message is being sent must
    // not mix one bot's token with another bot's chat.
    const owner = bot
    const paired = pairing
    try {
      const chatId = pairing.state.candidate.chatId
      // The owner is not asked who they are here; the first chat does that.
      const profile = provisionalProfile(pairing.state.candidate.name, owner.info.firstName, parseTimezone(body['timezone']))
      // No city is asked here, so there is nothing to look up.
      const answers = answersFromWeb(profile, engine, null, deps.projectRoot)
      // Vault first: if it cannot be written, nothing else is, and the page
      // can simply be submitted again.
      deps.vault.set('TELEGRAM_BOT_TOKEN', owner.token)
      if (engine.kind === 'api-key' && engine.provider) deps.vault.set(KEY_NAME[engine.provider], engine.key)
      writeConfiguration(answers, { chatId: String(chatId) }, deps.projectRoot, deps.home, { profilePending: true })
      // Consumed the moment the config exists, so a crash below cannot leave
      // a configured box with a live link.
      if (deps.mode === 'hosted') completeLink(deps.links, deps.now())
      finished = true
      paired.stop()

      let delivered = true
      try {
        await sendMessage(
          deps.fetch,
          owner.token,
          chatId,
          "Hi, I'm set up. I'll be ready in a minute or two, and then I'll ask a few quick questions so I can be useful."
        )
      } catch {
        delivered = false
      }
      json(res, 200, { ok: true, bot: owner.info.username, delivered, city: null })
      setImmediate(deps.onFinished)
    } catch (err) {
      finishing = false
      throw err
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname
    if (req.method === 'GET' && (p === '/setup' || p === '/setup/')) {
      if (admit(req, res, url, true)) servePage(res)
      return
    }
    if (!p.startsWith('/setup/api/')) {
      notFound(res)
      return
    }
    if (!admit(req, res, url, false)) return

    if (req.method === 'GET' && p === '/setup/api/state') {
      json(res, 200, {
        mode: deps.mode,
        subscription: subscriptionAllowed ? { signedIn: deps.claude!.signedIn() } : null,
        bot: bot ? { username: bot.info.username, name: bot.info.firstName } : null,
        pairing: pairingView(),
        managedAi: managed(),
        alreadySetUp: existsSync(resolve(deps.projectRoot, '.env')),
      })
      return
    }
    if (req.method === 'GET' && p === '/setup/api/telegram/pairing') {
      json(res, 200, pairingView())
      return
    }
    if (req.method !== 'POST') {
      notFound(res)
      return
    }
    const body = await readJson(req)
    switch (p) {
      case '/setup/api/telegram/token': {
        const token = typeof body['token'] === 'string' ? body['token'].trim() : ''
        const info = await checkBotToken(deps.fetch, token)
        pairing?.stop()
        bot = { token, info }
        pairing = new Pairing(deps.fetch, token, deps.now, deps.pollSeconds)
        pairing.run()
        json(res, 200, { username: info.username, name: info.firstName })
        return
      }
      case '/setup/api/telegram/confirm': {
        if (!pairing) {
          json(res, 400, { error: 'Connect a bot first.' })
          return
        }
        await pairing.confirm(body['yes'] === true)
        json(res, 200, pairingView())
        return
      }
      case '/setup/api/telegram/restart': {
        if (!bot) {
          json(res, 400, { error: 'Connect a bot first.' })
          return
        }
        pairing?.stop()
        pairing = new Pairing(deps.fetch, bot.token, deps.now, deps.pollSeconds)
        pairing.run()
        json(res, 200, pairingView())
        return
      }
      case '/setup/api/claude/sign-in': {
        if (!subscriptionAllowed) {
          json(res, 400, { error: 'Not available here.' })
          return
        }
        deps.claude!.start()
        json(res, 200, { started: true })
        return
      }
      case '/setup/api/finish':
        await finish(body, res)
        return
      default:
        notFound(res)
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://setup.invalid')
    route(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return
      if (err instanceof InputError || err instanceof TelegramError) json(res, 400, { error: err.message })
      else {
        // Never echo an unexpected error to the page: it could carry a request
        // body. Log only its message and stack, never the request.
        console.error('setup: unexpected error', err instanceof Error ? err.stack ?? err.message : String(err))
        json(res, 500, { error: 'Something went wrong. Try again.' })
      }
    })
  })
}
