/**
 * AiSdkAgentRuntime — the provider-agnostic agent loop (Phase 2 of the
 * LLM-agnostic plan, see projects/personal/ai-assistant-startup/).
 *
 * Owns everything the Claude Code harness provided invisibly: the tool
 * loop (Vercel AI SDK ToolLoopAgent), built-in tools, system prompt
 * assembly, and session persistence in SQLite. Behavior contracts mirror
 * the claude runtime where callers can observe them: retry/backoff on
 * transient errors, identical-tool-call loop guard, partial-stream
 * delivery on turn death, steer chaining, and the exact overload string
 * the scheduler keys off.
 *
 * Ships dark: select with AGENT_RUNTIME=ai-sdk in .env. Bills the API
 * directly (ANTHROPIC_API_KEY); onLaneSwitch never fires because there is
 * no subscription lane here. Anthropic prompt-cache breakpoints and the
 * history budget live in history.ts — both exist because this lane pays
 * per token, per step.
 */
import { ToolLoopAgent, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../types.js'
import { cachedSystem, historyMaxBytes, trimHistory, withCacheBreakpoint } from './history.js'
import { loadMcpTools } from './mcp.js'
import { buildSystemPrompt } from './prompt.js'
import { resolveModel } from './provider.js'
import { SessionStore } from './sessions.js'
import { createTools } from './tools.js'

/** Retry config for transient API errors — same shape as the claude runtime. */
const MAX_RETRIES = 3
const BASE_DELAY_MS = 5000 // 5s, 10s, 20s backoff

const MAX_STEPS = 50
const LOOP_THRESHOLD = 3 // consecutive identical tool calls

function isRetryableError(err: unknown): boolean {
  const msg = String(err)
  return /\b(529|overloaded)\b/i.test(msg)
    || /\b(429|rate.?limit)\b/i.test(msg)
    || /\b(503|service.?unavailable)\b/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class AiSdkAgentRuntime implements AgentRuntime {
  readonly id = 'ai-sdk'

  private pendingSteer: string | null = null
  private readonly activeWorkspaces = new Map<string, string>()
  private readonly sessions: SessionStore
  private readonly modelOverride?: LanguageModel

  /** `model` is a test seam: injects a mock model instead of resolveModel(). */
  constructor(sessions?: SessionStore, model?: LanguageModel) {
    this.sessions = sessions ?? new SessionStore()
    this.modelOverride = model
  }

  steer(message: string): void {
    this.pendingSteer = message
    logger.info({ steer: message.slice(0, 100) }, 'Steer message queued')
  }

  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return this.activeWorkspaces
  }

  /** MCP tools load once per runtime instance and stay connected (service lifetime). */
  private mcpToolsPromise: Promise<ToolSet> | null = null
  private getMcpTools(): Promise<ToolSet> {
    if (!this.mcpToolsPromise) this.mcpToolsPromise = loadMcpTools(PROJECT_ROOT)
    return this.mcpToolsPromise
  }

  /** Wrap tool executes so MCP tools also fire onToolProgress. */
  private withProgress(tools: ToolSet, notify?: (toolName: string, status: string) => void): ToolSet {
    if (!notify) return tools
    return Object.fromEntries(
      Object.entries(tools).map(([name, t]) => {
        const execute = (t as { execute?: (input: unknown, opts: unknown) => Promise<unknown> }).execute
        if (!execute) return [name, t]
        return [
          name,
          {
            ...t,
            execute: async (input: unknown, opts: unknown) => {
              try {
                notify(name, JSON.stringify(input ?? '').slice(0, 100))
              } catch {
                // progress reporting must never break a tool call
              }
              return execute(input, opts)
            },
          },
        ]
      })
    ) as ToolSet
  }

  /**
   * Subagent dispatch: a scoped one-shot agent with the same tool set but no
   * further subagent nesting (depth 1). The claude runtime gets this from
   * Claude Code's Agent tool; here it is just another runtime instance turn.
   */
  private buildSubagentTool(cwd: string, onToolProgress?: (toolName: string, status: string) => void) {
    return tool({
      description:
        'Dispatch a subagent to handle a self-contained task (research, multi-file analysis, a side quest '
        + 'that would clutter the main conversation). It runs with the same tools, works autonomously, and '
        + 'returns a final report. It has no memory of this conversation, so include all needed context in the prompt.',
      inputSchema: z.object({
        prompt: z.string().describe('Complete, self-contained task description for the subagent'),
        working_directory: z.string().optional().describe('Working directory for the subagent (defaults to the current one)'),
      }),
      execute: async ({ prompt, working_directory }) => {
        const subCwd = working_directory ?? cwd
        logger.info({ cwd: subCwd, prompt: prompt.slice(0, 100) }, 'Dispatching subagent')
        try {
          const sub = await this.buildAgent(subCwd, onToolProgress, { subagents: false })
          const result = await sub.generate({ prompt })
          return result.text.trim() || '(subagent returned no text)'
        } catch (err) {
          return `Subagent failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`
        }
      },
    })
  }

  private async buildAgent(
    cwd: string,
    onToolProgress?: (toolName: string, status: string) => void,
    opts: { subagents?: boolean } = {}
  ) {
    const { model, provider, modelId } = this.modelOverride
      ? { model: this.modelOverride, provider: 'override', modelId: 'override' }
      : resolveModel()
    const mcpTools = this.withProgress(await this.getMcpTools(), onToolProgress)
    const tools: ToolSet = {
      ...createTools(cwd, onToolProgress),
      ...mcpTools,
      ...(opts.subagents ? { dispatch_subagent: this.buildSubagentTool(cwd, onToolProgress) } : {}),
    }
    logger.info({ provider, modelId, cwd, toolCount: Object.keys(tools).length }, 'AI SDK agent configured')
    return new ToolLoopAgent({
      model,
      instructions: cachedSystem(buildSystemPrompt(cwd)),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // Move a cache breakpoint to the newest message on every step so each
      // request in the tool loop re-reads the prior prefix instead of
      // re-paying the whole conversation at full input price.
      prepareStep: ({ messages }) => ({ messages: withCacheBreakpoint(messages) }),
    })
  }

  /** One-shot turn: no session, no retries, errors propagate (contract parity with the claude runtime). */
  async runOnce(prompt: string, options: { workingDirectory?: string } = {}): Promise<string> {
    const cwd = options.workingDirectory ?? PROJECT_ROOT
    const agent = await this.buildAgent(cwd)
    const result = await agent.generate({ prompt })
    return result.text.trim()
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const cwd = options.workingDirectory ?? PROJECT_ROOT
    const sessionId = options.sessionId ?? this.sessions.newSessionId()
    const loaded: ModelMessage[] = (options.sessionId ? this.sessions.load(options.sessionId) : null) ?? []
    // Bound the replayed conversation; the save below persists the trimmed
    // history, so the stored session shrinks along with the request.
    const history: ModelMessage[] = trimHistory(loaded, historyMaxBytes())
    if (history.length < loaded.length) {
      logger.info(
        { dropped: loaded.length - history.length, kept: history.length },
        'Session history exceeded budget; trimmed oldest turns'
      )
    }
    const messages: ModelMessage[] = [...history, { role: 'user', content: options.message }]

    this.activeWorkspaces.set(sessionId, cwd)
    try {
      let lastError: unknown

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          logger.info({ attempt, delay }, 'Retrying after transient error')
          await sleep(delay)
        }

        const typingInterval = options.onTyping ? setInterval(options.onTyping, 4000) : null
        let streamedText = ''
        let loopSignature = ''
        let loopCount = 0
        let loopDetected = false
        let streamError: unknown
        const abort = new AbortController()

        try {
          logger.info({ attempt, sessionId, historyLength: history.length }, 'Starting AI SDK agent turn')
          const agent = await this.buildAgent(cwd, options.onToolProgress, { subagents: true })
          const result = await agent.stream({ messages, abortSignal: abort.signal })

          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              streamedText += part.text
              options.onPartial?.(streamedText)
            } else if (part.type === 'tool-call') {
              const sig = JSON.stringify({ n: part.toolName, i: part.input })
              if (sig === loopSignature) {
                loopCount++
                if (loopCount >= LOOP_THRESHOLD) {
                  loopDetected = true
                  abort.abort()
                  break
                }
              } else {
                loopSignature = sig
                loopCount = 1
              }
            } else if (part.type === 'error') {
              // The SDK surfaces provider failures (429/529/503, auth, etc.) as
              // in-band error parts and then finishes the stream normally — it
              // does NOT throw. Capture and re-throw below so the retry/backoff
              // classification actually engages (found by umi-tester: without
              // this, transient errors returned silent nulls and the scheduler's
              // overload contract never fired).
              streamError = part.error
            }
          }

          if (loopDetected) {
            logger.error({ signature: loopSignature.slice(0, 200) }, 'Loop detected: identical tool calls repeated, aborting')
            this.sessions.save(sessionId, messages)
            return {
              text: `Loop detected: the agent repeated the same tool call ${LOOP_THRESHOLD} times. Aborting to prevent infinite loop. Try rephrasing or starting a /newchat.`,
              newSessionId: sessionId,
            }
          }

          if (streamError !== undefined) {
            throw streamError instanceof Error ? streamError : new Error(String(streamError))
          }

          const response = await result.response
          messages.push(...response.messages)
          this.sessions.save(sessionId, messages)

          let text = (await result.text).trim() || null
          // Reply reconciliation, same contract as the claude runtime: a partial
          // beats "(no response)" when the turn died after streaming text.
          if (!text && streamedText.trim().length > 0) {
            logger.warn({ partialLength: streamedText.length }, 'Reconciling partial stream as response')
            text = `${streamedText.trim()}\n\n_(partial reply, turn ended without a final result)_`
          }

          // Steer chaining: run the queued follow-up on the same session.
          if (this.pendingSteer) {
            const steerMsg = `[steer]: ${this.pendingSteer}`
            this.pendingSteer = null
            logger.info('Executing queued steer message')
            return this.run({ ...options, message: steerMsg, sessionId })
          }

          return { text, newSessionId: sessionId }
        } catch (err) {
          lastError = err
          logger.error({ err, attempt }, 'AI SDK agent turn failed')

          // A truncated real answer beats a fabricated one (claude runtime contract).
          if (streamedText.trim().length > 0) {
            logger.warn({ attempt, partialLength: streamedText.length }, 'Partial stream before error; delivering it')
            this.sessions.save(sessionId, messages)
            return { text: `${streamedText.trim()}\n\n_(partial reply, turn ended early)_`, newSessionId: sessionId }
          }

          if (attempt < MAX_RETRIES && isRetryableError(err)) {
            continue // retry
          }

          // Exact wording contract: the scheduler's OVERLOAD_PATTERN keys off this string.
          if (isRetryableError(err)) {
            return { text: 'API is temporarily overloaded. Will try again on the next run.', newSessionId: sessionId }
          }

          const detail = String((err as Error)?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 300)
          return { text: `Ran into an error and couldn't finish that: ${detail}`, newSessionId: sessionId }
        } finally {
          if (typingInterval) clearInterval(typingInterval)
        }
      }

      logger.error({ lastError }, 'Exhausted all retries')
      return { text: 'API is temporarily overloaded. Will try again on the next run.', newSessionId: sessionId }
    } finally {
      this.activeWorkspaces.delete(sessionId)
      this.pendingSteer = null
    }
  }
}
