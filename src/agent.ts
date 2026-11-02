/**
 * Agent facade.
 *
 * Phase 1 of the LLM-agnostic roadmap: the Claude Agent SDK now lives
 * entirely behind the AgentRuntime interface (src/runtime/). This module keeps the historical positional runAgent()
 * signature and the per-chat lane tracking, so bot/scheduler/cockpit/
 * http-server callers are unchanged. Lane tracking stays here (not in the
 * runtime) because it is provider-neutral chat concurrency, not a property
 * of any one model harness.
 */
import { getAgentRuntime, resolveTurnRuntime, type RuntimeLane } from './runtime/index.js'
import type { AgentRunResult, RunScope } from './runtime/types.js'
import { withRunOrNew } from './assurance/effect-journal.js'
import { withEgress } from './egress/index.js'

/**
 * Lane-based concurrency tracking (OpenClaw v2026.5.19 -- cron wake-lane isolation).
 * Each chat can have at most one active agent run. Cron tasks yield to chat tasks
 * so scheduled prompts never stall a live conversation.
 */
export type AgentLane = 'chat' | 'cron'
const activeLanes = new Map<string, AgentLane>()

/** Check if a chat (or any chat) has an active agent run */
export function isChatBusy(chatId?: string): boolean {
  if (chatId) return activeLanes.has(chatId)
  return activeLanes.size > 0
}

/** Check if a specific chat has an active chat-lane run (not cron) */
export function isChatLaneActive(chatId: string): boolean {
  return activeLanes.get(chatId) === 'chat'
}

export function markLane(chatId: string, lane: AgentLane): void {
  activeLanes.set(chatId, lane)
}

export function clearLane(chatId: string): void {
  activeLanes.delete(chatId)
}

/** Queue a message to inject as a follow-up after the current run completes. */
export function steerAgent(message: string): void {
  // A chat on another provider's model runs on its own runtime (card #270):
  // steer the one the latest chat turn went to.
  getAgentRuntime('chat', lastChatRuntimeId).steer(message)
}

/** The runtime the most recent chat-lane turn ran on, for /steer. */
let lastChatRuntimeId: string | undefined

/**
 * Public agent entry point. Delegates one full turn (including retries) to
 * the configured AgentRuntime.
 */
export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  onPartial?: (accumulated: string) => void,
  onToolProgress?: (toolName: string, status: string) => void,
  lane: RuntimeLane = 'chat',
  signal?: AbortSignal,
  scope?: RunScope,
  opts?: { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' }
): Promise<AgentRunResult> {
  // One turn is one run for the effect journal (card #229), unless the caller
  // already named the run: a scheduled job or an approval card.
  // With EGRESS=enforce the turn's tools get their own egress proxy (card #231).
  // The chat's /model choice may name another provider's model, which runs on
  // the runtime that can reach it (card #270).
  const turn = resolveTurnRuntime(lane, opts?.model)
  if (lane === 'chat') lastChatRuntimeId = turn.id
  return withRunOrNew('turn', () => withEgress({ roleId: scope?.role }, () => getAgentRuntime(lane, turn.id).run({
    message,
    sessionId,
    onTyping,
    onPartial,
    onToolProgress,
    signal,
    scope,
    ...(turn.model ? { model: turn.model } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
  })))
}
