/**
 * Runtime registry and factory with task-class routing (Layer 3 of the
 * LLM-agnostic plan).
 *
 * Selection by lane:
 *   - chat (default): AGENT_RUNTIME in .env, falling back to process.env,
 *     then 'claude'
 *   - cron (scheduled tasks, batch jobs): AGENT_RUNTIME_CRON if set,
 *     otherwise same as chat
 *
 * Rationale: unattended multi-agent work (e.g. overnight batch dispatches)
 * is the expensive lane and also the one that needs Claude Code's agent
 * roster (.claude/agents/*.md only exists in the claude runtime). Routing
 * cron to 'claude' keeps that work on the subscription while chat can run
 * a provider-agnostic runtime ('ai-sdk'). Env is re-read on every call, so
 * switching runtimes only needs a .env edit, not a service restart.
 * Instances are cached per runtime id and can coexist.
 */
import { isManagedAi, managedEngine } from '../ai-limit.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { getSecret } from '../vault/index.js'
import { KEY_ENV, parseModelRef } from './model-ref.js'
import { AiSdkAgentRuntime } from './ai-sdk/index.js'
import { ClaudeAgentRuntime } from './claude.js'
import type { AgentRuntime } from './types.js'

export type { AgentRuntime, AgentRunOptions, AgentRunResult, LaneSwitchInfo } from './types.js'

/** Task class used to pick a runtime. 'cron' = scheduled/unattended work. */
export type RuntimeLane = 'chat' | 'cron'

const factories: Record<string, () => AgentRuntime> = {
  claude: () => new ClaudeAgentRuntime(),
  'ai-sdk': () => new AiSdkAgentRuntime(),
}

const instances = new Map<string, AgentRuntime>()
let override: AgentRuntime | null = null

export function resolveRuntimeId(lane: RuntimeLane): string {
  // A managed box (card #158) runs every lane on its engine's runtime: claude
  // for the Anthropic key, ai-sdk for an open model through a US host (card
  // #268). That is where the managed key, the pause and the guards live.
  // AGENT_RUNTIME and AGENT_RUNTIME_CRON are ignored while managed.
  if (isManagedAi()) return managedEngine() === 'open-model' ? 'ai-sdk' : 'claude'
  const env = readEnvFile()
  if (lane === 'cron') {
    const cronId = env.AGENT_RUNTIME_CRON?.trim() || process.env.AGENT_RUNTIME_CRON?.trim()
    if (cronId) return cronId
  }
  return env.AGENT_RUNTIME?.trim() || process.env.AGENT_RUNTIME?.trim() || 'claude'
}

/**
 * The runtime and model for one turn with a chat's /model choice (card #270).
 *
 * - Managed boxes run only what the plan prices: tier aliases on the Claude
 *   engine, nothing but the configured model on the open-model engine.
 * - A 'provider:modelId' choice whose key has gone is dropped (box default).
 * - Another provider's model on a claude-runtime box runs on ai-sdk.
 * - An 'anthropic:' choice on the claude runtime is passed as the bare id.
 */
export function resolveTurnRuntime(lane: RuntimeLane, model: string | undefined): { id: string; model: string | undefined } {
  const base = resolveRuntimeId(lane)
  const m = model?.trim() || undefined
  if (!m) return { id: base, model: undefined }
  const ref = parseModelRef(m)
  if (isManagedAi()) {
    if (managedEngine() === 'open-model') return { id: base, model: undefined }
    return { id: base, model: ref ? undefined : m }
  }
  if (!ref) return { id: base, model: m }
  if (!getSecret(KEY_ENV[ref.provider]!)) return { id: base, model: undefined }
  if (base === 'claude') return ref.provider === 'anthropic' ? { id: base, model: ref.modelId } : { id: 'ai-sdk', model: m }
  return { id: base, model: m }
}

/** The runtime id a chat's choice runs on: a change of it means a fresh conversation. */
export function runtimeIdFor(lane: RuntimeLane, model: string | undefined): string {
  return resolveTurnRuntime(lane, model).id
}

export function getAgentRuntime(lane: RuntimeLane = 'chat', id: string = resolveRuntimeId(lane)): AgentRuntime {
  if (override) return override
  let instance = instances.get(id)
  if (!instance) {
    const factory = factories[id]
    if (!factory) {
      throw new Error(`Unknown AGENT_RUNTIME '${id}'. Available: ${Object.keys(factories).join(', ')}`)
    }
    instance = factory()
    instances.set(id, instance)
    logger.info({ runtime: instance.id, lane }, 'Agent runtime selected')
  }
  return instance
}

/** Ids of the runtimes with a turn running now, for /steer. */
export function busyRuntimeIds(): string[] {
  if (override) return override.getActiveWorkspaces().size > 0 ? [override.id] : []
  return [...instances.entries()].filter(([, r]) => r.getActiveWorkspaces().size > 0).map(([id]) => id)
}

/** Test seam: force one runtime for all lanes. Pass null to re-resolve from env. */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  override = runtime
  if (!runtime) instances.clear()
}
