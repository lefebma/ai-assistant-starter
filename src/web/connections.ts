/**
 * Connection status for the web Settings panel. Each source is a small
 * injectable function; one failing never throws and never hides the others.
 * No secret value, masked tail or token ever leaves here: only account
 * labels (addresses), which the signed-in owner already knows.
 */
import { execFile } from 'node:child_process'
import { PRIMARY_CHAT_ID, STORE_DIR, TELEGRAM_BOT_TOKEN } from '../config.js'
import { readEnvFile } from '../env.js'
import { resolveGogBin } from '../infra/gog-bin.js'
import { listAuthedAccounts } from '../ms/store.js'
import { listAccounts as listImapAccounts } from '../imap/store.js'
import { voiceCapabilities } from '../voice.js'
import { shortcutTokenInfo } from '../shortcut-tokens.js'
import { isManagedAi } from '../ai-limit.js'
import { readAiUsage } from '../ai-usage.js'
import { spawnClaudeAsync } from '../infra/claude-auth.js'
import { parseGmailAccounts } from '../email-alerts/sources.js'

export interface Connection {
  id: string
  name: string
  status: 'connected' | 'attention' | 'off'
  detail: string
  next?: string
}

export interface ConnectionDeps {
  /** Resolves with ok/detail for the model provider. */
  model(): Promise<{ ok: boolean; detail: string }>
  telegramConfigured(): boolean
  /** Gmail addresses signed in through gog, or null when gog is not installed. */
  gmailAccounts(): Promise<string[] | null>
  outlookAccounts(): string[]
  imapAccounts(): string[]
  voice(): { stt: boolean; tts: boolean }
  /** Shortcut key info for the signed-in owner chat. */
  shortcut(chatId: string): { createdAt: number; lastUsedAt: number | null } | null
  managedAi(): boolean
  /** Month usage for managed AI, or null when unknown. */
  aiUsage(): { usd: number; capUsd?: number } | null
  /** Mailboxes the live probe found broken. */
  brokenMailboxes(): Promise<{ id: string; why: string }[]>
  chatId(): string
}

const ASK_PROVIDER = 'Ask your provider to set this up.'
const COULD_NOT_CHECK = 'Could not check'

const GMAIL_TIMEOUT_MS = 5_000
const CHECK_CACHE_MS = 5 * 60_000

/**
 * A slow check run at most once per `ttlMs`, with concurrent callers sharing
 * the one in flight. A failure is not cached, so the next call tries again.
 */
export function cachedCheck<T>(
  fn: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): { get(): Promise<T>; reset(): void } {
  let cached: { at: number; value: T } | null = null
  let inFlight: Promise<T> | null = null
  let generation = 0
  return {
    get() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value)
      if (inFlight) return inFlight
      const gen = generation
      const p = fn().then(
        (value) => {
          if (gen === generation) cached = { at: now(), value }
          return value
        },
      )
      inFlight = p
      const clear = () => {
        if (inFlight === p) inFlight = null
      }
      p.then(clear, clear)
      return p
    },
    reset() {
      generation++
      cached = null
      inFlight = null
    },
  }
}

function runGog(): Promise<string[] | null> {
  const bin = resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
  return new Promise<string[] | null>((resolve, reject) => {
    execFile(bin, ['auth', 'list', '--plain'], { timeout: GMAIL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // Not installed: Gmail is simply off. Any other failure is a real problem.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null)
        return reject(err)
      }
      resolve(parseGmailAccounts(String(stdout)))
    })
  })
}

/**
 * The model check asks `claude auth status`, which costs a process start.
 * Async (never spawnSync on a request path), cached and shared like Gmail.
 */
async function runModelCheck(): Promise<{ ok: boolean; detail: string }> {
  const { credentialStatus } = await import('../selftest.js')
  const s = await credentialStatus(spawnClaudeAsync)
  return { ok: s.ok, detail: s.detail }
}

const gmailCheck = cachedCheck(runGog, CHECK_CACHE_MS)
const modelCheck = cachedCheck(runModelCheck, CHECK_CACHE_MS)

export function resetConnectionCache(): void {
  gmailCheck.reset()
  modelCheck.reset()
}

export const defaultConnectionDeps: ConnectionDeps = {
  model: () => modelCheck.get(),
  telegramConfigured: () => TELEGRAM_BOT_TOKEN.trim() !== '',
  gmailAccounts: () => gmailCheck.get(),
  outlookAccounts: () => listAuthedAccounts(),
  imapAccounts: () => listImapAccounts().map((a) => a.address),
  voice: () => voiceCapabilities(),
  shortcut: (chatId) => shortcutTokenInfo(chatId),
  managedAi: () => isManagedAi(),
  aiUsage: () => {
    const u = readAiUsage(STORE_DIR)
    return u ? { usd: u.usd, capUsd: u.capUsd } : null
  },
  async brokenMailboxes() {
    const { discoverMailboxes } = await import('../email-alerts/sources.js')
    return (await discoverMailboxes()).broken
  },
  chatId: () => PRIMARY_CHAT_ID,
}

let activeDeps: ConnectionDeps = defaultConnectionDeps

/** The sources the web routes use. Tests swap them so no real binary runs. */
export function connectionDeps(): ConnectionDeps {
  return activeDeps
}

/** Test hook: replace the route's sources. Pass null to restore the real ones. */
export function setConnectionDepsForTest(deps: ConnectionDeps | null): void {
  activeDeps = deps ?? defaultConnectionDeps
}

/** Run one source; any throw becomes an attention entry rather than an error. */
async function guard(id: string, name: string, fn: () => Promise<Connection> | Connection): Promise<Connection> {
  try {
    return await fn()
  } catch {
    return { id, name, status: 'attention', detail: COULD_NOT_CHECK }
  }
}

function accountList(list: string[]): string {
  return list.length === 1 ? list[0]! : `${list.length} accounts: ${list.join(', ')}`
}

export async function getConnections(deps: ConnectionDeps = defaultConnectionDeps): Promise<Connection[]> {
  const out = await Promise.all([
    guard('model', 'AI model', async () => {
      const m = await deps.model()
      return m.ok
        ? { id: 'model', name: 'AI model', status: 'connected', detail: m.detail }
        : { id: 'model', name: 'AI model', status: 'attention', detail: m.detail || 'Not signed in', next: ASK_PROVIDER }
    }),
    guard('telegram', 'Telegram', () =>
      deps.telegramConfigured()
        ? { id: 'telegram', name: 'Telegram', status: 'connected', detail: 'Bot is set up' }
        : { id: 'telegram', name: 'Telegram', status: 'off', detail: 'Not set up', next: ASK_PROVIDER },
    ),
    guard('gmail', 'Gmail', async () => {
      const list = await deps.gmailAccounts()
      return list && list.length
        ? { id: 'gmail', name: 'Gmail', status: 'connected', detail: accountList(list) }
        : { id: 'gmail', name: 'Gmail', status: 'off', detail: 'No Gmail account connected', next: ASK_PROVIDER }
    }),
    guard('outlook', 'Outlook', () => {
      const list = deps.outlookAccounts()
      return list.length
        ? { id: 'outlook', name: 'Outlook', status: 'connected', detail: accountList(list) }
        : { id: 'outlook', name: 'Outlook', status: 'off', detail: 'No Outlook account connected', next: ASK_PROVIDER }
    }),
    guard('imap', 'Other email (IMAP)', () => {
      const list = deps.imapAccounts()
      return list.length
        ? { id: 'imap', name: 'Other email (IMAP)', status: 'connected', detail: accountList(list) }
        : { id: 'imap', name: 'Other email (IMAP)', status: 'off', detail: 'No other mailbox connected', next: ASK_PROVIDER }
    }),
    guard('voice', 'Voice', () => {
      const v = deps.voice()
      if (v.stt && v.tts) return { id: 'voice', name: 'Voice', status: 'connected', detail: 'Hears and speaks' }
      if (v.stt || v.tts)
        return { id: 'voice', name: 'Voice', status: 'connected', detail: v.stt ? 'Hears voice notes' : 'Speaks replies' }
      return { id: 'voice', name: 'Voice', status: 'off', detail: 'Voice is not available', next: ASK_PROVIDER }
    }),
    guard('shortcut', 'Siri and Shortcuts', () => {
      const info = deps.shortcut(deps.chatId())
      return info
        ? {
            id: 'shortcut',
            name: 'Siri and Shortcuts',
            status: 'connected',
            detail: info.lastUsedAt ? 'Key made and in use' : 'Key made, not used yet',
          }
        : {
            id: 'shortcut',
            name: 'Siri and Shortcuts',
            status: 'off',
            detail: 'No key yet',
            next: 'Send /shortcut to your assistant to set this up.',
          }
    }),
  ])
  const managed = await guard('managed-ai', 'Managed AI allowance', () => {
    if (!deps.managedAi()) return { id: 'managed-ai', name: 'Managed AI allowance', status: 'off', detail: 'Not used' }
    const u = deps.aiUsage()
    const detail =
      u && u.capUsd
        ? `$${u.usd.toFixed(2)} of $${u.capUsd.toFixed(2)} used this month`
        : u
          ? `$${u.usd.toFixed(2)} used this month`
          : 'Managed by your provider'
    const near = !!u && !!u.capUsd && u.usd >= u.capUsd * 0.8
    return { id: 'managed-ai', name: 'Managed AI allowance', status: near ? 'attention' : 'connected', detail }
  })
  return managed.status === 'off' && managed.detail === 'Not used' ? out : [...out, managed]
}

/** Like getConnections, plus a live mailbox probe. Only for the Check now button. */
export async function checkConnectionsNow(deps: ConnectionDeps = defaultConnectionDeps): Promise<Connection[]> {
  resetConnectionCache()
  const list = await getConnections(deps)
  let broken: { id: string; why: string }[] = []
  try {
    broken = await deps.brokenMailboxes()
  } catch {
    return list.map((c) =>
      ['gmail', 'outlook', 'imap'].includes(c.id) && c.status === 'connected'
        ? { ...c, status: 'attention' as const, detail: COULD_NOT_CHECK }
        : c,
    )
  }
  if (!broken.length) return list
  // A broken entry is either a provider id ('gmail', 'outlook') or a mailbox
  // address, which appears in the connection's account list.
  return list.map((c) => {
    const hit = broken.find((b) => b.id === c.id || (c.status === 'connected' && c.detail.includes(b.id)))
    return hit ? { ...c, status: 'attention' as const, detail: hit.why, next: ASK_PROVIDER } : c
  })
}
