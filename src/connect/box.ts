/**
 * Box side of the sign-in relay: the /connect command and hand-off acceptance.
 *
 * The box issues a random nonce per /connect, remembers it for 10 minutes and
 * puts it in the link. The relay carries it through the provider sign-in and
 * returns it with the tokens. A hand-off is accepted only if (a) its body is
 * signed with this box's hand-off key, (b) the nonce is one this box issued and
 * has not yet spent, and (c) it names the provider that nonce was issued for.
 * The nonce is spent the moment it is looked up, so a replay always fails.
 * The box holds no OAuth client secret. Tokens go to the vault and never into
 * a reply, a log line or the model.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface ConnectTokenVault {
  get(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): boolean
}

/** Revokes a refresh token at the provider. Throws if the provider did not confirm. */
export type Revoker = (tokens: { accessToken: string; refreshToken: string }) => Promise<void>

export interface ConnectOpts {
  relayUrl: string
  boxId: string
  handoffKey: string
  vault: ConnectTokenVault
  revokers: Record<string, Revoker>
  now?: () => number
  ttlMs?: number
}

export interface HandoffResult {
  status: 200 | 400 | 401 | 403
  chatId?: string
  message?: string
}

interface Pending {
  provider: string
  chatId: string
  expiresAt: number
}

const PROVIDERS = ['gmail', 'outlook'] as const
const APP_PASSWORD = ['yahoo', 'icloud']
const vaultName = (p: string) => `CONNECT_${p.toUpperCase()}`
const USAGE = [
  'Connect your mail and calendar:',
  '/connect gmail - sign in with Google',
  '/connect outlook - sign in with Microsoft',
  '/connect yahoo - uses an app password via /secret',
  '/connect list - what is connected',
  '/connect remove <gmail|outlook> - revoke at the provider and delete here',
].join('\n')

export class ConnectFlow {
  private readonly pending = new Map<string, Pending>()
  private readonly now: () => number
  private readonly ttl: number

  constructor(private readonly o: ConnectOpts) {
    this.now = o.now ?? Date.now
    this.ttl = o.ttlMs ?? 10 * 60_000
    if (o.handoffKey.length < 32) throw new Error('hand-off key must be at least 32 characters')
  }

  /** Sync half: everything except remove. */
  handleCommand(chatId: string, text: string): { reply: string } {
    const [, sub, arg] = text.trim().split(/\s+/)
    if (sub === 'remove') return { reply: 'Use handleCommandAsync for remove.' }
    if (sub === 'list') {
      const on = PROVIDERS.filter((p) => this.o.vault.get(vaultName(p)))
        .map((p) => `${p}: ${(JSON.parse(this.o.vault.get(vaultName(p))!) as { account?: string }).account ?? 'connected'}`)
      return { reply: on.length ? on.join('\n') : 'Nothing connected yet.' }
    }
    if (sub && APP_PASSWORD.includes(sub)) {
      return { reply: `${sub[0].toUpperCase()}${sub.slice(1)} uses an app password, not a sign-in. Run /secret set ${sub.toUpperCase()}_APP_PASSWORD and paste it when I ask.` }
    }
    if (!sub || !(PROVIDERS as readonly string[]).includes(sub)) return { reply: USAGE }
    void arg
    this.sweep()
    for (const [n, p] of this.pending) if (p.chatId === chatId && p.provider === sub) this.pending.delete(n)
    const nonce = randomBytes(24).toString('base64url')
    this.pending.set(nonce, { provider: sub, chatId, expiresAt: this.now() + this.ttl })
    const link = new URL('/start', this.o.relayUrl)
    link.searchParams.set('provider', sub)
    link.searchParams.set('box', this.o.boxId)
    link.searchParams.set('nonce', nonce)
    return { reply: `Open this on your phone, sign in and tap Allow. It works once and expires in 10 minutes.\n${link.toString()}` }
  }

  async handleCommandAsync(chatId: string, text: string): Promise<{ reply: string }> {
    const parts = text.trim().split(/\s+/)
    if (parts[1] !== 'remove') return this.handleCommand(chatId, text)
    const provider = parts[2]
    if (!provider || !(PROVIDERS as readonly string[]).includes(provider)) return { reply: 'Usage: /connect remove <gmail|outlook>' }
    const raw = this.o.vault.get(vaultName(provider))
    if (!raw) return { reply: `Nothing connected for ${provider}.` }
    const localOnly = parts[3] === '--local-only'
    let refresh = ''
    let access = ''
    try {
      const t = JSON.parse(raw) as { refreshToken?: string; accessToken?: string }
      refresh = t.refreshToken ?? ''
      access = t.accessToken ?? ''
    } catch {
      /* corrupt entry: nothing to revoke, fall through to delete */
    }
    if (localOnly || !refresh) {
      this.o.vault.delete(vaultName(provider))
      return { reply: `Removed ${provider} from this box. The token was not revoked at the provider; remove access in your account security settings.` }
    }
    try {
      await this.o.revokers[provider]({ accessToken: access, refreshToken: refresh })
    } catch {
      return { reply: `Could not revoke ${provider} at the provider, so I kept it here. Try again, or run /connect remove ${provider} --local-only to delete it locally only.` }
    }
    this.o.vault.delete(vaultName(provider))
    return { reply: `Removed ${provider}: revoked at the provider and deleted from this box.` }
  }

  async acceptHandoff(rawBody: string, signature: string): Promise<HandoffResult> {
    const want = createHmac('sha256', this.o.handoffKey).update(rawBody).digest()
    const got = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401 }
    let b: Record<string, unknown>
    try {
      b = JSON.parse(rawBody)
    } catch {
      return { status: 400 }
    }
    const { nonce, provider, account, accessToken, refreshToken, expiresAt, ts } = b
    if (typeof nonce !== 'string' || typeof provider !== 'string' || typeof account !== 'string' || typeof accessToken !== 'string' ||
        typeof refreshToken !== 'string' || typeof expiresAt !== 'number' || typeof ts !== 'number') return { status: 400 }
    // Spend the nonce first: whatever happens next, it cannot be used again.
    const p = this.pending.get(nonce)
    this.pending.delete(nonce)
    const now = this.now()
    if (!p || p.expiresAt < now || p.provider !== provider || Math.abs(now - ts) > this.ttl) return { status: 403 }
    this.o.vault.set(vaultName(provider), JSON.stringify({ account, accessToken, refreshToken, expiresAt }))
    return { status: 200, chatId: p.chatId, message: `Connected ${account}, mail and calendar working.` }
  }

  private sweep(): void {
    const now = this.now()
    for (const [n, p] of this.pending) if (p.expiresAt < now) this.pending.delete(n)
  }
}
