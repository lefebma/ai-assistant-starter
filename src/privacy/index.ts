/**
 * The anonymizer for a run (card #187): names and companies never leave the
 * machine.
 *
 * runAgent and runOnce wrap a private run in withPrivacy(). Inside it:
 *   - the claude runtime gives its CLI a base URL on the local proxy
 *     (privateCliEnv, proxy.ts), which masks each request and restores the
 *     reply;
 *   - the ai-sdk runtime wraps its model in the middleware (privateModel,
 *     middleware.ts), which does the same in process.
 *
 * Outside a private run both are no-ops, so nothing changes for a box that
 * never turns it on.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { privacyMiddleware } from './middleware.js'
import { DEFAULT_UPSTREAM, openRoute } from './proxy.js'
import { privacyState } from './store.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'

type RunPrivacy = { drops: Array<() => void>; routes: Array<() => number> }
const store = new AsyncLocalStorage<RunPrivacy>()

/** Run `fn` anonymized when `on`. Routes it opened on the proxy close when it ends. */
export async function withPrivacy<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  if (!on || store.getStore()) return fn()
  const ctx: RunPrivacy = { drops: [], routes: [] }
  try {
    const result = await store.run(ctx, fn)
    // A CLI that never called the relay went somewhere else (a settings file
    // this check did not foresee). Too late for this turn: say so loudly.
    if (ctx.routes.length && ctx.routes.every((hits) => hits() === 0)) {
      logger.error('privacy filter: a private turn finished without one request through the relay; check Claude Code settings for a base URL or provider override')
    }
    return result
  } finally {
    for (const d of ctx.drops) d()
  }
}

/** True inside a private run. */
export function privacyActive(): boolean {
  return Boolean(store.getStore())
}

/**
 * Whether a turn for this chat (or for no chat) is private right now. Never
 * throws. PRIVACY=on is read before the store, so it always holds. A switch
 * that cannot be read counts as on (the turn then fails rather than going out
 * unfiltered), except in a store that was never set up, where no chat can
 * have turned it on.
 */
export function privacyOnFor(chatId: string | undefined, state: (chatId: string | undefined) => { on: boolean } = privacyState): boolean {
  try {
    return state(chatId).on
  } catch (err) {
    if (/no such table/i.test(String(err))) return false
    logger.error({ err: String(err) }, 'privacy filter: could not read the switch; treating it as on')
    return true
  }
}

/** What a voice call hears instead of an answer while the filter is on: speaking it would send the names to the voice service. */
export const PRIVATE_VOICE_NOTICE = 'The privacy filter is on, so I cannot answer that on a voice call. Ask me in the chat instead.'

/**
 * The CLI env for a private run: `env` (or the process env) with
 * ANTHROPIC_BASE_URL on the proxy, which forwards to whatever base URL the
 * env had. Unchanged outside a private run.
 */
export async function privateCliEnv<E extends Record<string, string | undefined>>(env: E | undefined, cwd: string = process.cwd()): Promise<E | NodeJS.ProcessEnv | undefined> {
  const ctx = store.getStore()
  if (!ctx) return env
  const base = env ?? process.env
  const bypass = relayBypass(base, cwd)
  if (bypass) throw new Error(`The privacy filter is on, but ${bypass}, so Claude Code would not send this turn through the filter. The turn was not sent.`)
  const route = await openRoute(base.ANTHROPIC_BASE_URL?.trim() || DEFAULT_UPSTREAM)
  ctx.drops.push(route.drop)
  ctx.routes.push(route.hits)
  return { ...base, ANTHROPIC_BASE_URL: route.baseUrl }
}

const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
const truthy = (v: unknown) => typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim())

/**
 * Why Claude Code would not use the relay, or null. It ignores the base URL
 * when sending to Bedrock, Vertex or Foundry, and an env block in its
 * settings files overrides the env this process gives it.
 */
export function relayBypass(env: Record<string, string | undefined>, cwd: string, home: string = homedir()): string | null {
  for (const k of PROVIDER_SWITCHES) if (truthy(env[k])) return `${k} is set`
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  const files = [
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    // Managed (admin) settings, which win over everything else.
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json',
  ]
  for (const f of files) {
    let raw: string
    try {
      raw = readFileSync(f, 'utf8')
    } catch {
      continue // not there
    }
    let parsed: { env?: Record<string, unknown> }
    try {
      parsed = JSON.parse(raw) as { env?: Record<string, unknown> }
    } catch {
      // Unreadable here, maybe not to the CLI: it could name a base URL.
      return `${f} could not be read`
    }
    const e = parsed?.env
    if (!e || typeof e !== 'object') continue
    if (typeof e.ANTHROPIC_BASE_URL === 'string' && e.ANTHROPIC_BASE_URL.trim()) return `${f} sets ANTHROPIC_BASE_URL`
    for (const k of PROVIDER_SWITCHES) if (truthy(e[k])) return `${f} sets ${k}`
  }
  return null
}

/** True when an address is this machine or a private network (a local model, not a public one). */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (!m) return false
  const a = Number(m[1]), b = Number(m[2])
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

/** Whether the ai-sdk runtime's model for `provider` is reached on a local address (AI_BASE_URL). */
export function localModelHost(provider: string, read: (k: string) => string | undefined = envRead): boolean {
  if (provider !== 'openai' && provider !== 'azure') return false
  if (provider !== (read('AI_PROVIDER') || 'anthropic')) return false
  return isLocalUrl(read('AI_BASE_URL'))
}

function envRead(k: string): string | undefined {
  try {
    return readEnvFile()[k]?.trim() || process.env[k]?.trim() || undefined
  } catch {
    return process.env[k]?.trim() || undefined
  }
}

/** The ai-sdk model for this run: wrapped in the anonymizer inside a private run, unless the model is local. */
export function privateModel(model: LanguageModel, opts: { local?: boolean } = {}): LanguageModel {
  if (!store.getStore() || opts.local || typeof model === 'string') return model
  return wrapLanguageModel({ model: model as LanguageModelV3, middleware: privacyMiddleware() })
}
