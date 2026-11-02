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
 *
 * Outlook tokens go into the Microsoft token store (src/ms/store.ts), one
 * entry per mailbox, the same place a device-code sign-in puts them. So the
 * Outlook tools, ms-auth status and the web Connections page all see the new
 * mailbox, and the box refreshes it with the public client id alone. Gmail
 * tokens go to CONNECT_GMAIL, which the relay renews and GmailTokenKeeper
 * (gmail-token.ts) hands to gog.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface ConnectTokenVault {
  get(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): boolean
}

/** The Microsoft token store, as src/ms/store.ts exposes it. expiresAt is epoch seconds. */
export interface MsTokenStore {
  save(account: string, tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void
  load(account: string): { accessToken: string; refreshToken: string } | null
  clear(account: string): boolean
  /** Account labels as stored (slugged), not the original addresses. */
  list(): string[]
}

/** Revokes a refresh token at the provider. Throws if the provider did not confirm. */
export type Revoker = (tokens: { accessToken: string; refreshToken: string }) => Promise<void>

/**
 * Microsoft has no call that ends one app's grant for a personal account, and
 * revokeSignInSessions needs a permission Havn does not ask for (and signs the
 * person out of everything). So removing Outlook deletes here and says where
 * to withdraw the access itself.
 */
export const OUTLOOK_WITHDRAW =
  'Microsoft does not let me cancel the sign-in itself, so also remove Havn in your Microsoft account: ' +
  'personal accounts at https://account.live.com/consent/Manage, work accounts at https://myapps.microsoft.com (Havn, then Revoke permissions).'

export interface ConnectOpts {
  relayUrl: string
  boxId: string
  handoffKey: string
  vault: ConnectTokenVault
  msTokens: MsTokenStore
  /** Gmail is revoked through the relay. Outlook has none (see OUTLOOK_WITHDRAW). */
  revokers: Partial<Record<string, Revoker>>
  now?: () => number
  ttlMs?: number
  /** Called after a provider is connected or removed. */
  onChange?: (provider: string) => void | Promise<void>
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

function accountOf(raw: string): string | undefined {
  try {
    return (JSON.parse(raw) as { account?: string }).account
  } catch {
    return undefined
  }
}
const USAGE = [
  'Connect your mail and calendar:',
  '/connect gmail - sign in with Google',
  '/connect outlook - sign in with Microsoft',
  '/connect yahoo - uses an app password via /secret',
  '/connect list - what is connected',
  '/connect remove gmail - revoke at the provider and delete here',
  '/connect remove outlook <account> - delete one Outlook mailbox here',
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
      const on: string[] = []
      const gmail = this.o.vault.get(vaultName('gmail'))
      if (gmail) on.push(`gmail: ${accountOf(gmail) ?? 'connected'}`)
      for (const a of this.o.msTokens.list()) on.push(`outlook: ${a}`)
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
    const localOnly = parts.includes('--local-only')
    const rest = parts.slice(3).filter((x) => x !== '--local-only')
    if (provider === 'gmail') {
      const raw = this.o.vault.get(vaultName('gmail'))
      if (!raw) return { reply: 'Nothing connected for gmail.' }
      let t: { refreshToken?: string; accessToken?: string } = {}
      try {
        t = JSON.parse(raw)
      } catch {
        /* corrupt entry: nothing to revoke, fall through to delete */
      }
      const out = await this.remove('gmail', 'gmail', t, localOnly, () => this.o.vault.delete(vaultName('gmail')))
      if (!this.o.vault.get(vaultName('gmail'))) await this.o.onChange?.('gmail')
      return out
    }
    if (provider === 'outlook') {
      const accounts = this.o.msTokens.list()
      const asked = rest[0]
      const account = asked ?? (accounts.length === 1 ? accounts[0] : undefined)
      if (!account) {
        return { reply: accounts.length ? `Which mailbox? /connect remove outlook <${accounts.join('|')}>` : 'Nothing connected for outlook.' }
      }
      const t = this.o.msTokens.load(account)
      if (!t) return { reply: `Nothing connected for outlook ${account}.` }
      this.o.msTokens.clear(account)
      await this.o.onChange?.('outlook')
      return { reply: `Removed outlook ${account} from this box. ${OUTLOOK_WITHDRAW}` }
    }
    return { reply: 'Usage: /connect remove gmail, or /connect remove outlook <account>' }
  }

  private async remove(
    provider: string, label: string, t: { refreshToken?: string; accessToken?: string }, localOnly: boolean, drop: () => boolean,
  ): Promise<{ reply: string }> {
    const refresh = t.refreshToken ?? ''
    if (localOnly || !refresh) {
      drop()
      return { reply: `Removed ${label} from this box. The token was not revoked at the provider; remove access in your account security settings.` }
    }
    const revoker = this.o.revokers[provider]
    if (!revoker) {
      drop()
      return { reply: `Removed ${label} from this box. The token was not revoked at the provider; remove access in your account security settings.` }
    }
    try {
      await revoker({ accessToken: t.accessToken ?? '', refreshToken: refresh })
    } catch {
      return { reply: `Could not revoke ${label} at the provider, so I kept it here. Try again, or run /connect remove ${label} --local-only to delete it locally only.` }
    }
    drop()
    return { reply: `Removed ${label}: revoked at the provider and deleted from this box.` }
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
    if (provider === 'outlook') {
      // The relay stamps milliseconds; the Microsoft store keeps seconds.
      this.o.msTokens.save(account, { accessToken, refreshToken, expiresAt: Math.floor(expiresAt / 1000) })
    } else {
      this.o.vault.set(vaultName(provider), JSON.stringify({ account, accessToken, refreshToken, expiresAt }))
    }
    await this.o.onChange?.(provider)
    return { status: 200, chatId: p.chatId, message: `Connected ${account}, mail and calendar working.` }
  }

  private sweep(): void {
    const now = this.now()
    for (const [n, p] of this.pending) if (p.expiresAt < now) this.pending.delete(n)
  }
}
