/**
 * Provider-agnostic agent runtime contract.
 *
 * Phase 1 of the LLM-agnostic roadmap.
 * The runtime owns one agent turn: prompt in, final text out, with streaming
 * and tool-progress callbacks along the way. Everything above this interface
 * (Telegram bot, scheduler, cockpit, lane tracking) is provider-neutral;
 * everything below it is the implementation detail of one provider harness.
 */

/** Fired once when a billing/provider fallback lane engages mid-turn. */
export type LaneSwitchInfo = { rateLimitType?: string; resetsAt?: number }

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
}

export type AgentRunResult = {
  text: string | null
  newSessionId?: string
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
  runOnce(prompt: string, options?: { workingDirectory?: string }): Promise<string>
  /** Queue a message to inject as a follow-up after the current run completes. */
  steer(message: string): void
  /** Active session workspaces (sessionId -> cwd) for subagent conflict detection. */
  getActiveWorkspaces(): ReadonlyMap<string, string>
}
