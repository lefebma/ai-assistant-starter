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
import { getAgentRuntime } from './runtime/index.js'

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
  getAgentRuntime().steer(message)
}

/**
 * Public agent entry point. Delegates one full turn (including retries) to
 * the configured AgentRuntime.
 */
export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  onPartial?: (accumulated: string) => void,
  onToolProgress?: (toolName: string, status: string) => void
): Promise<{ text: string | null; newSessionId?: string }> {
  return getAgentRuntime().run({
    message,
    sessionId,
    onTyping,
    onPartial,
    onToolProgress,
  })
}
