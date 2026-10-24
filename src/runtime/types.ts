/**
 * Provider-agnostic agent runtime contract.
 *
 * Phase 1 of the LLM-agnostic roadmap.
 * The runtime owns one agent turn: prompt in, final text out, with streaming
 * and tool-progress callbacks along the way. Everything above this interface
 * (Telegram bot, scheduler, cockpit, lane tracking) is provider-neutral;
 * everything below it is the implementation detail of one provider harness.
 */
import type { AiLimitKind } from '../ai-limit.js'

/** Fired once when a billing/provider fallback lane engages mid-turn. */
export type LaneSwitchInfo = { rateLimitType?: string; resetsAt?: number }

export type RunScope = {
  /** A role id from src/assurance/roles.ts or roles.json. */
  role: string
  /** The scheduled task, so a refusal can name the command that fixes it. */
  taskId?: string
}

export type AgentRunOptions = {
  message: string
  /** Provider conversation id to resume; the runtime returns the new one. */
  sessionId?: string
  /** Defaults to PROJECT_ROOT. */
  workingDirectory?: string
  /** Poked every few seconds while the turn runs (chat typing indicator). */
  onTyping?: () => void
  /** Accumulated streamed text so far, fired on each text delta. */
  onPartial?: (accumulated: string) => void
  /** Tool activity for streaming progress previews. */
  onToolProgress?: (toolName: string, status: string) => void
  /** Fired once if the runtime escalates to a paid/fallback billing lane. */
  onLaneSwitch?: (info: LaneSwitchInfo) => void
  /**
   * Cancels the turn. On abort the runtime stops the underlying model/CLI
   * work, skips retries and fallback lanes, and resolves with `text: null`
   * (never throws). Callers treat a null text after abort as "cancelled".
   */
  signal?: AbortSignal
  /**
   * Role-scoped run (card #195): only this role's tools are offered and every
   * call is checked against it. Scheduled jobs set it; chat never does.
   */
  scope?: RunScope
  /**
   * Model for this turn only, overriding the configured default. Prefer a
   * bare tier alias: 'haiku' (cheap), 'sonnet' (default) or 'opus' (strong).
   * The ai-sdk runtime maps those to the provider's configured models.
   */
  model?: string
  /** Reasoning effort for this turn only. Omitted means the SDK default. */
  effort?: 'low' | 'medium' | 'high'
  /**
   * A turn that cannot act, for feeding untrusted text (e.g. email triage):
   * no tools, no MCP servers, no skills or settings sources (no CLAUDE.md),
   * no session resume or persistence, a single model turn. Only the text
   * output comes back. Steer messages are neither consumed nor chained.
   */
  isolated?: boolean
}

export type AgentRunResult = {
  text: string | null
  newSessionId?: string
  /**
   * Managed boxes only (card #158): set when the turn did not run, or stopped,
   * because the AI allowance is used up. `text` is null; the caller tells the
   * owner. Never set on a non-managed box.
   */
  aiPaused?: AiLimitKind
}

export interface AgentRuntime {
  /** Stable id used in config and logs, e.g. 'claude'. */
  readonly id: string
  /** Run one full agent turn, including internal retries and lane fallbacks. */
  run(options: AgentRunOptions): Promise<AgentRunResult>
  /**
   * One-shot turn: prompt in, final text out. No session resume, no retries,
   * no fallback lanes, errors propagate. For batch jobs (e.g. the nightly
   * dreaming sweep) where the caller owns failure handling and a retry or an
   * error-message-as-text would corrupt the output.
   */
  runOnce(prompt: string, options?: { workingDirectory?: string; model?: string }): Promise<string>
  /** Queue a message to inject as a follow-up after the current run completes. */
  steer(message: string): void
  /** Active session workspaces (sessionId -> cwd) for subagent conflict detection. */
  getActiveWorkspaces(): ReadonlyMap<string, string>
}
