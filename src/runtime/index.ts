/**
 * Runtime registry and factory.
 *
 * Selects the AgentRuntime implementation from AGENT_RUNTIME in .env
 * (falling back to process.env, then 'claude'). Phase 2 of the LLM-agnostic
 * plan (docs/llm-agnostic-architecture.md) adds provider-agnostic runtimes
 * here; nothing above this module knows which provider is running.
 */
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { ClaudeAgentRuntime } from './claude.js'
import type { AgentRuntime } from './types.js'

export type { AgentRuntime, AgentRunOptions, AgentRunResult, LaneSwitchInfo } from './types.js'

const factories: Record<string, () => AgentRuntime> = {
  claude: () => new ClaudeAgentRuntime(),
}

let instance: AgentRuntime | null = null

export function getAgentRuntime(): AgentRuntime {
  if (!instance) {
    const id = readEnvFile().AGENT_RUNTIME?.trim()
      || process.env.AGENT_RUNTIME?.trim()
      || 'claude'
    const factory = factories[id]
    if (!factory) {
      throw new Error(`Unknown AGENT_RUNTIME '${id}'. Available: ${Object.keys(factories).join(', ')}`)
    }
    instance = factory()
    logger.info({ runtime: instance.id }, 'Agent runtime selected')
  }
  return instance
}

/** Test seam: swap or clear the active runtime. Pass null to re-resolve from env. */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  instance = runtime
}
