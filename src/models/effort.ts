/**
 * Effort (card #272): how hard the assistant thinks before answering, and
 * which levels the model a turn runs on accepts.
 *
 * A chat's stored choice is one of EFFORTS or '' (the default). It is never
 * sent as is: fitEffort() matches it to the levels the turn's model has, so a
 * model without an effort setting gets none, and a level the model lacks runs
 * as the nearest level below it.
 *
 * Where the levels come from:
 *   - claude runtime: the list the Claude CLI reports for its models
 *     (recorded on every turn, see claude-models.ts), else the Claude rule
 *     (effort-levels.ts) for a full id; a tier alias not yet reported offers every level,
 *     since the CLI itself lowers one its model lacks.
 *   - ai-sdk runtime: per provider. Claude models follow the Claude rule,
 *     OpenAI's reasoning models (GPT-5 family, o-series) take low to high,
 *     Gemini 3 and later take thinking levels. A model reached through
 *     AI_BASE_URL (Together, Ollama, a gateway) or an Azure deployment has no
 *     known setting, so none is sent.
 */
import { isManagedAi, managedEngine } from '../ai-limit.js'
import { readEnvFile } from '../env.js'
import { resolveTurnRuntime, type RuntimeLane } from '../runtime/index.js'
import { resolveModel as resolveClaudeModel } from '../runtime/claude.js'
import { resolveModel as resolveAiSdkModel } from '../runtime/ai-sdk/provider.js'
import { claudeRuntimeLevels } from './claude-models.js'
import { aiSdkEffortLevels, type Effort } from './effort-levels.js'

export * from './effort-levels.js'

export type EffortDeps = {
  read?: (key: string) => string | undefined
}

function envRead(): (key: string) => string | undefined {
  const env = readEnvFile()
  return (key) => env[key]?.trim() || process.env[key]?.trim() || undefined
}

/**
 * The levels the model a turn would run on accepts, for a chat whose /model
 * choice is `model` (undefined = the box default). Empty: no effort setting.
 * Never throws.
 */
export function effortLevelsFor(lane: RuntimeLane, model: string | undefined, deps: EffortDeps = {}): Effort[] {
  try {
    // The managed open model is priced and tuned as one fixed setup.
    if (isManagedAi() && managedEngine() === 'open-model') return []
    const turn = resolveTurnRuntime(lane, model)
    if (turn.id === 'claude') return claudeRuntimeLevels(turn.model ?? resolveClaudeModel())
    const read = deps.read ?? envRead()
    const { provider, modelId } = resolveAiSdkModel(turn.model)
    // AI_BASE_URL belongs to the configured provider (see provider.ts).
    const configured = read('AI_PROVIDER') || 'anthropic'
    const viaBaseUrl = provider === configured && (provider === 'openai' || provider === 'azure') && !!read('AI_BASE_URL')
    return aiSdkEffortLevels(provider, modelId, viaBaseUrl)
  } catch {
    return []
  }
}
