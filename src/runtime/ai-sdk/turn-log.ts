/**
 * One line when an ai-sdk turn ends (card #279).
 *
 * The claude runtime ends every turn with "Agent result received". The ai-sdk
 * runtime logged the start and then nothing, so service.log could not tell a
 * finished turn from a hung one, or say how long it took. This is that line:
 * the outcome and the numbers, never the reply text.
 */
import { logger } from '../../logger.js'

export type TurnOutcome = 'success' | 'error' | 'cancelled'

/** Why a turn ended the way it did, when the outcome alone does not say. */
export type TurnReason = 'loop' | 'partial' | 'overloaded' | 'retries_exhausted' | 'spend_limit' | 'steered'

export interface TurnEnd {
  kind: 'turn' | 'isolated' | 'subagent'
  outcome: TurnOutcome
  reason?: TurnReason
  provider?: string
  modelId?: string
  sessionId?: string
  /** Characters in the reply that went back, 0 for none. */
  replyLength: number
  durationMs: number
  steps: number
  toolCalls: number
  /** Model attempts, counting retries. Not set for subagents. */
  attempts?: number
}

export const TURN_END_MESSAGE = 'AI SDK agent turn ended'

export function logTurnEnd(end: TurnEnd): void {
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(end)) if (v !== undefined) fields[k] = v
  if (end.outcome === 'error') logger.warn(fields, TURN_END_MESSAGE)
  else logger.info(fields, TURN_END_MESSAGE)
}

/** Step and tool-call counts from a generate() result, tolerating mocks without steps. */
export function countSteps(result: unknown): { steps: number; toolCalls: number } {
  const steps = (result as { steps?: unknown })?.steps
  if (!Array.isArray(steps)) return { steps: 0, toolCalls: 0 }
  let toolCalls = 0
  for (const s of steps) {
    const calls = (s as { toolCalls?: unknown })?.toolCalls
    if (Array.isArray(calls)) toolCalls += calls.length
  }
  return { steps: steps.length, toolCalls }
}
