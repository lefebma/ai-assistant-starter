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
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
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

function resolveRuntimeId(lane: RuntimeLane): string {
  const env = readEnvFile()
  if (lane === 'cron') {
    const cronId = env.AGENT_RUNTIME_CRON?.trim() || process.env.AGENT_RUNTIME_CRON?.trim()
    if (cronId) return cronId
  }
  return env.AGENT_RUNTIME?.trim() || process.env.AGENT_RUNTIME?.trim() || 'claude'
}

export function getAgentRuntime(lane: RuntimeLane = 'chat'): AgentRuntime {
  if (override) return override
  const id = resolveRuntimeId(lane)
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

/** Test seam: force one runtime for all lanes. Pass null to re-resolve from env. */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  override = runtime
  if (!runtime) instances.clear()
}
