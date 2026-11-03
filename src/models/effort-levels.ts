/**
 * Effort levels (card #272): the levels, which ones each model accepts, and
 * fitting a chat's stored choice to them. No imports, so both runtimes and
 * the /effort command can use it. effort.ts works out the model a turn runs on.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type Effort = (typeof EFFORTS)[number]

export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
}

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

/**
 * The levels a Claude model id accepts, or null when the id is not a Claude
 * model id this rule knows. Current models (generation 5, Opus 4.7 and 4.8)
 * take every level; Opus and Sonnet 4.6 stop at high; Opus 4.5 takes low to
 * high; older Claude models have no effort setting.
 */
export function claudeEffortLevels(modelId: string): Effort[] | null {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(modelId.trim())
  if (!m) return null
  const family = m[1]!
  const major = Number(m[2])
  const minor = m[3] === undefined ? 0 : Number(m[3])
  if (major >= 5) return [...EFFORTS]
  if (major === 4 && family === 'opus' && minor >= 7) return [...EFFORTS]
  if (major === 4 && minor === 6 && (family === 'opus' || family === 'sonnet')) return ['low', 'medium', 'high']
  if (major === 4 && minor === 5 && family === 'opus') return ['low', 'medium', 'high']
  return []
}

/** The levels a model reached through the AI SDK accepts. */
export function aiSdkEffortLevels(provider: string, modelId: string, viaBaseUrl: boolean): Effort[] {
  if (viaBaseUrl) return []
  const id = modelId.trim().toLowerCase()
  if (provider === 'anthropic') return claudeEffortLevels(id) ?? []
  if (provider === 'openai') {
    if (/^gpt-5/.test(id) && !/-chat/.test(id)) return ['low', 'medium', 'high']
    // o1-mini and o1-preview predate reasoning effort and reject it.
    if (/^o\d/.test(id) && !/^o1-(mini|preview)/.test(id)) return ['low', 'medium', 'high']
    return []
  }
  if (provider === 'google') {
    const g = /^gemini-(\d+)/.exec(id)
    if (!g || Number(g[1]) < 3) return []
    return /-pro/.test(id) ? ['low', 'high'] : ['low', 'medium', 'high']
  }
  return []
}

/**
 * The level to send for a stored choice on a model with `levels`: the choice
 * itself, the nearest level below it the model has, or nothing.
 */
export function fitEffort(effort: string | undefined, levels: readonly Effort[]): Effort | undefined {
  if (!isEffort(effort) || levels.length === 0) return undefined
  if (levels.includes(effort)) return effort
  const at = EFFORTS.indexOf(effort)
  for (let i = at - 1; i >= 0; i--) if (levels.includes(EFFORTS[i]!)) return EFFORTS[i]
  return undefined
}

/** Provider options that carry a level to the AI SDK provider. */
export function effortProviderOptions(provider: string, effort: Effort | undefined): Record<string, Record<string, string | Record<string, string>>> | undefined {
  if (!effort) return undefined
  if (provider === 'anthropic') return { anthropic: { effort } }
  if (provider === 'openai') return { openai: { reasoningEffort: effort } }
  if (provider === 'google') return { google: { thinkingConfig: { thinkingLevel: effort } } }
  return undefined
}
