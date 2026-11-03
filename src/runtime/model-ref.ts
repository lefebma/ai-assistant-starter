/**
 * Model references (card #270): what a chat's `/model` choice stores and a
 * turn's `model` option carries.
 *
 *   ''                     the box default
 *   'haiku' | 'sonnet' | 'opus'   a tier alias (both runtimes understand them)
 *   'provider:modelId'     one provider's model, e.g. 'openai:gpt-5.5'
 *
 * Anything else is passed through unchanged as a bare model id, as before.
 */

/** Env var holding each provider's API key. Also gates the known-provider set. */
export const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_API_KEY',
}

export type ParsedModelRef = { provider: string; modelId: string }

/** 'openai:gpt-5.5' -> { provider: 'openai', modelId: 'gpt-5.5' }; anything else -> null. */
export function parseModelRef(ref: string | undefined): ParsedModelRef | null {
  const t = ref?.trim()
  if (!t) return null
  const i = t.indexOf(':')
  if (i <= 0) return null
  const provider = t.slice(0, i)
  const modelId = t.slice(i + 1).trim()
  if (!KEY_ENV[provider] || !modelId) return null
  return { provider, modelId }
}
