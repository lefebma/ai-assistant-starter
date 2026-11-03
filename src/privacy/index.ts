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
import { wrapLanguageModel, type LanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { privacyMiddleware } from './middleware.js'
import { DEFAULT_UPSTREAM, openRoute } from './proxy.js'
import { privacyState } from './store.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'

type RunPrivacy = { drops: Array<() => void> }
const store = new AsyncLocalStorage<RunPrivacy>()

/** Run `fn` anonymized when `on`. Routes it opened on the proxy close when it ends. */
export async function withPrivacy<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  if (!on || store.getStore()) return fn()
  const ctx: RunPrivacy = { drops: [] }
  try {
    return await store.run(ctx, fn)
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
 * throws. PRIVACY=on is read before the store, so it always holds; a chat's
 * own switch that cannot be read counts as off, since the list lives in the
 * same store and there would be nothing to mask with.
 */
export function privacyOnFor(chatId: string | undefined): boolean {
  try {
    return privacyState(chatId).on
  } catch (err) {
    logger.warn({ err: String(err) }, 'privacy filter: could not read the switch; treating it as off')
    return false
  }
}

/**
 * The CLI env for a private run: `env` (or the process env) with
 * ANTHROPIC_BASE_URL on the proxy, which forwards to whatever base URL the
 * env had. Unchanged outside a private run.
 */
export async function privateCliEnv<E extends Record<string, string | undefined>>(env: E | undefined): Promise<E | NodeJS.ProcessEnv | undefined> {
  const ctx = store.getStore()
  if (!ctx) return env
  const base = env ?? process.env
  const route = await openRoute(base.ANTHROPIC_BASE_URL?.trim() || DEFAULT_UPSTREAM)
  ctx.drops.push(route.drop)
  return { ...base, ANTHROPIC_BASE_URL: route.baseUrl }
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
