/**
 * The models `/model` offers (card #270).
 *
 * One list per box: the latest model of each family from every provider that
 * has an API key in the settings, plus the box's own default. "Latest" comes
 * from each provider's models endpoint, cached for a day in
 * store/model-catalog.json; a failed call falls back to the cache, and with no
 * cache that provider offers only what the settings configure. Hosts that list
 * hundreds of models (AI_BASE_URL) and Azure (whose key lists deployments, not
 * the vendor's models) offer only the configured models.
 *
 * A choice's `ref` is what gets stored per chat and handed to the runtime as
 * the turn's model: '' (the default), a tier alias ('haiku', 'sonnet',
 * 'opus') or 'provider:modelId'. See parseModelRef in runtime/model-ref.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { STORE_DIR } from '../config.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { getSecret } from '../vault/index.js'
import { isManagedAi, managedEngine } from '../ai-limit.js'
import { KEY_ENV } from '../runtime/model-ref.js'

export type ModelChoice = {
  /** Stored per chat and passed as the turn's model. '' is the box default. */
  ref: string
  /** Button text, kept short for Telegram. */
  label: string
  /** Which runtime runs it: a switch across runtimes starts a fresh conversation. */
  runtime: 'claude' | 'ai-sdk'
}

/** One model as a provider lists it. */
export type ListedModel = { id: string; name?: string; created?: number }

type FetchedProvider = 'anthropic' | 'openai' | 'google'

type CacheFile = {
  fetchedAt: Record<string, number>
  models: Record<string, ListedModel[]>
}

const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 8_000

/** Claude tiers on the claude runtime: aliases keep resolving to the newest model in each tier. */
const CLAUDE_TIERS: ModelChoice[] = [
  { ref: 'haiku', label: 'Claude Haiku', runtime: 'claude' },
  { ref: 'sonnet', label: 'Claude Sonnet', runtime: 'claude' },
  { ref: 'opus', label: 'Claude Opus', runtime: 'claude' },
]

/** Families kept per provider, newest first within each. Order is the button order. */
const FAMILIES: Record<FetchedProvider, Array<{ key: string; match: RegExp }>> = {
  anthropic: [
    { key: 'haiku', match: /^claude-haiku-\d/ },
    { key: 'sonnet', match: /^claude-sonnet-\d/ },
    { key: 'opus', match: /^claude-opus-\d/ },
    { key: 'fable', match: /^claude-fable-\d/ },
  ],
  openai: [
    { key: 'gpt', match: /^gpt-\d+(\.\d+)?$/ },
    { key: 'gpt-mini', match: /^gpt-\d+(\.\d+)?-mini$/ },
    { key: 'gpt-nano', match: /^gpt-\d+(\.\d+)?-nano$/ },
  ],
  google: [
    { key: 'pro', match: /^gemini-\d+(\.\d+)?-pro$/ },
    { key: 'flash', match: /^gemini-\d+(\.\d+)?-flash$/ },
    { key: 'flash-lite', match: /^gemini-\d+(\.\d+)?-flash-lite$/ },
  ],
}

/** Numeric parts of an id, for ordering when a provider gives no date. */
function versionOf(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number)
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** Newer first: by date when both have one, else by the version in the id. */
function newerFirst(a: ListedModel, b: ListedModel): number {
  if (a.created && b.created && a.created !== b.created) return b.created - a.created
  return compareVersions(versionOf(b.id), versionOf(a.id))
}

/** The newest listed model of each family, in family order. */
export function latestPerFamily(provider: FetchedProvider, models: ListedModel[]): ListedModel[] {
  const out: ListedModel[] = []
  for (const fam of FAMILIES[provider]) {
    const hits = models.filter((m) => fam.match.test(m.id)).sort(newerFirst)
    if (hits[0]) out.push(hits[0])
  }
  return out
}

/** "gpt-5.5-mini" -> "GPT-5.5 mini", "gemini-3-flash-lite" -> "Gemini 3 Flash-Lite". */
export function labelFor(provider: string, m: ListedModel): string {
  if (m.name) return m.name.slice(0, 30)
  if (provider === 'openai') return m.id.replace(/^gpt-/, 'GPT-').replace(/-(mini|nano)$/, ' $1').slice(0, 30)
  if (provider === 'google') {
    return m.id
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-flash-lite$/, ' Flash-Lite')
      .replace(/-flash$/, ' Flash')
      .replace(/-pro$/, ' Pro')
      .slice(0, 30)
  }
  return m.id.slice(0, 30)
}

// --- Fetching ---

/** Pull one provider's list. Throws on any failure; the caller falls back. */
export async function fetchModels(provider: FetchedProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<ListedModel[]> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  if (provider === 'anthropic') {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { data?: Array<{ id: string; display_name?: string; created_at?: string }> }
    return (j.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name,
      created: m.created_at ? Date.parse(m.created_at) || undefined : undefined,
    }))
  }
  if (provider === 'openai') {
    const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { data?: Array<{ id: string; created?: number }> }
    return (j.data ?? []).map((m) => ({ id: m.id, created: m.created ? m.created * 1000 : undefined }))
  }
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
    { signal }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = (await res.json()) as {
    models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>
  }
  return (j.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName }))
}

function cachePath(): string {
  return resolve(STORE_DIR, 'model-catalog.json')
}

function readCache(): CacheFile {
  try {
    if (existsSync(cachePath())) {
      const j = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile
      if (j && typeof j === 'object' && j.models && j.fetchedAt) return j
    }
  } catch {
    /* a damaged cache is refetched */
  }
  return { fetchedAt: {}, models: {} }
}

function writeCache(c: CacheFile): void {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true })
    const tmp = `${cachePath()}.tmp`
    writeFileSync(tmp, JSON.stringify(c))
    renameSync(tmp, cachePath())
  } catch (err) {
    logger.warn({ err }, 'Could not write the model catalog cache')
  }
}

/** One provider's latest models: cache when fresh, else the endpoint, else the stale cache. */
async function latestFor(
  provider: FetchedProvider,
  key: string,
  deps: { fetchImpl: typeof fetch; now: number; cache: CacheFile }
): Promise<{ models: ListedModel[]; changed: boolean }> {
  const { cache, now } = deps
  const at = cache.fetchedAt[provider] ?? 0
  if (cache.models[provider] && now - at < DAY_MS) return { models: cache.models[provider]!, changed: false }
  try {
    const picked = latestPerFamily(provider, await fetchModels(provider, key, deps.fetchImpl))
    cache.models[provider] = picked
    cache.fetchedAt[provider] = now
    return { models: picked, changed: true }
  } catch (err) {
    logger.warn({ provider, detail: err instanceof Error ? err.message : String(err) }, 'Model list unavailable; using the cached list')
    return { models: cache.models[provider] ?? [], changed: false }
  }
}

// --- The box's choices ---

export type CatalogDeps = {
  fetchImpl?: typeof fetch
  now?: number
  /** Settings lookup (.env, then process.env). */
  read?: (key: string) => string | undefined
  /** Key lookup (vault, then .env). */
  secret?: (name: string) => string | undefined
  managed?: { on: boolean; engine: string }
  /** The runtime the chat lane runs on without a choice. */
  boxRuntime?: 'claude' | 'ai-sdk'
}

function defaultRead(): (key: string) => string | undefined {
  const env = readEnvFile()
  return (key) => env[key]?.trim() || process.env[key]?.trim() || undefined
}

/** The box's chat-lane runtime, the same rule runtime/index.ts uses. */
function defaultBoxRuntime(read: (key: string) => string | undefined): 'claude' | 'ai-sdk' {
  if (isManagedAi()) return managedEngine() === 'open-model' ? 'ai-sdk' : 'claude'
  return read('AGENT_RUNTIME') === 'ai-sdk' ? 'ai-sdk' : 'claude'
}

/** What the box runs when the chat has no choice, in words. */
export function describeDefault(deps: CatalogDeps = {}): string {
  const read = deps.read ?? defaultRead()
  const runtime = deps.boxRuntime ?? defaultBoxRuntime(read)
  if (runtime === 'claude') {
    const m = read('AGENT_MODEL') || 'sonnet'
    return /^(haiku|sonnet|opus)$/.test(m) ? `Claude ${m[0]!.toUpperCase()}${m.slice(1)}` : m
  }
  const provider = read('AI_PROVIDER') || 'anthropic'
  const m = read('AI_MODEL') || (provider === 'anthropic' ? 'claude-sonnet-5' : '')
  return m ? m.split('/').pop()! : 'not set'
}

function configuredModels(provider: string, read: (key: string) => string | undefined): ModelChoice[] {
  const ids = [read('AI_MODEL'), read('AI_MODEL_CHEAP'), read('AI_MODEL_STRONG')].filter((v): v is string => !!v)
  return [...new Set(ids)].map((id) => ({ ref: `${provider}:${id}`, label: id.split('/').pop()!.slice(0, 30), runtime: 'ai-sdk' as const }))
}

/**
 * Every model `/model` may offer on this box, default first. Never throws: a
 * provider that cannot be reached is left out (or served from cache).
 */
export async function listModelChoices(deps: CatalogDeps = {}): Promise<ModelChoice[]> {
  const read = deps.read ?? defaultRead()
  const secret = deps.secret ?? ((name: string) => getSecret(name) ?? undefined)
  const managed = deps.managed ?? { on: isManagedAi(), engine: managedEngine() }
  const boxRuntime = deps.boxRuntime ?? defaultBoxRuntime(read)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now()

  const choices: ModelChoice[] = [{ ref: '', label: `Default (${describeDefault({ read, boxRuntime })})`.slice(0, 40), runtime: boxRuntime }]
  // Managed boxes offer only what the plan prices (card #268): every Claude
  // tier on the Claude engine, nothing but the configured model on the open one.
  if (managed.on) {
    if (managed.engine !== 'open-model') choices.push(...CLAUDE_TIERS)
    return choices
  }

  const cache = readCache()
  let changed = false
  const fetched = async (provider: FetchedProvider): Promise<ListedModel[]> => {
    const key = secret(KEY_ENV[provider]!)
    if (!key) return []
    const r = await latestFor(provider, key, { fetchImpl, now, cache })
    changed ||= r.changed
    return r.models
  }

  const aiProvider = read('AI_PROVIDER') || 'anthropic'
  const baseURL = read('AI_BASE_URL')

  // Claude: tiers on the claude runtime (its CLI knows the aliases), the
  // listed ids on the ai-sdk runtime.
  if (boxRuntime === 'claude') choices.push(...CLAUDE_TIERS)
  else {
    for (const m of await fetched('anthropic')) choices.push({ ref: `anthropic:${m.id}`, label: labelFor('anthropic', m), runtime: 'ai-sdk' })
  }

  // OpenAI, or the OpenAI-compatible host in AI_BASE_URL (configured models only).
  if (baseURL) {
    if (secret(KEY_ENV.openai!) && (aiProvider === 'openai' || boxRuntime === 'claude')) choices.push(...configuredModels('openai', read))
  } else {
    for (const m of await fetched('openai')) choices.push({ ref: `openai:${m.id}`, label: labelFor('openai', m), runtime: 'ai-sdk' })
  }

  for (const m of await fetched('google')) choices.push({ ref: `google:${m.id}`, label: labelFor('google', m), runtime: 'ai-sdk' })

  // Azure: the deployments the settings name.
  if (aiProvider === 'azure' && secret(KEY_ENV.azure!)) choices.push(...configuredModels('azure', read))

  if (changed) writeCache(cache)
  // Same ref twice (a configured id that is also the latest) shows once.
  const seen = new Set<string>()
  return choices.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)))
}

/** The choice a typed `/model <text>` means: an exact ref, else the first label or id containing it. */
export function matchChoice(choices: ModelChoice[], text: string): ModelChoice | undefined {
  const t = text.trim().toLowerCase()
  if (!t) return undefined
  if (t === 'default') return choices.find((c) => c.ref === '')
  return (
    choices.find((c) => c.ref.toLowerCase() === t) ??
    choices.find((c) => c.ref !== '' && (c.label.toLowerCase().includes(t) || c.ref.toLowerCase().includes(t)))
  )
}
