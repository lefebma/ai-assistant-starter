/**
 * ClaudeAgentRuntime -- the Claude Agent SDK behind the AgentRuntime interface.
 *
 * Moved verbatim from src/agent.ts in Phase 1 of the LLM-agnostic roadmap.
 * This is the only file in the codebase that may import
 * @anthropic-ai/claude-agent-sdk.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from './types.js'

/** Retry config for transient API errors (429, 529, etc.) */
const MAX_RETRIES = 3
const BASE_DELAY_MS = 5000 // 5s, 10s, 20s backoff

/**
 * Post-compaction loop guard (inspired by OpenClaw v2026.5.4).
 * Detects repeated identical (tool, args, result) triples after context
 * overflow and aborts to prevent infinite loops in long-running dispatches.
 */
const LOOP_THRESHOLD = 3 // consecutive identical events

/**
 * The assistant pins its own model instead of inheriting the `model` key that
 * `settingSources: ['user']` would pull from ~/.claude/settings.json. That key
 * follows whatever you last picked in Claude Code interactively, and the Claude
 * binary vendored with the SDK only understands models it shipped knowing about.
 * Picking a newer one there would otherwise take every scheduled task down.
 *
 * Deliberately a bare alias, not a dated id like `claude-opus-4-6`: aliases keep
 * resolving to the current model in that tier as the pinned SDK moves, so this
 * default does not rot. Override with AGENT_MODEL in .env.
 */
const DEFAULT_MODEL = 'sonnet'

function resolveModel(): string {
  return readEnvFile().AGENT_MODEL?.trim()
    || process.env.AGENT_MODEL?.trim()
    || DEFAULT_MODEL
}

function isRetryableError(err: unknown): boolean {
  const msg = String(err)
  // 529 = overloaded, 429 = rate limited, 503 = service unavailable
  return /\b(529|overloaded)\b/i.test(msg)
    || /\b(429|rate.?limit)\b/i.test(msg)
    || /\b(503|service.?unavailable)\b/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = 'claude'

  /** Pending steer message: injected as the next prompt after current run completes */
  private pendingSteer: string | null = null

  private loopLastSignature = ''
  private loopRepeatCount = 0

  steer(message: string): void {
    this.pendingSteer = message
    logger.info({ steer: message.slice(0, 100) }, 'Steer message queued')
  }

  /** This runtime does not track subagent workspaces yet; always empty. */
  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return new Map()
  }

  /** One-shot turn, moved verbatim from src/dreaming/index.ts runDreamingAgent(). */
  async runOnce(prompt: string, options: { workingDirectory?: string } = {}): Promise<string> {
    let fullText = ''
    const conversation = query({
      prompt,
      options: {
        model: resolveModel(),
        cwd: options.workingDirectory ?? PROJECT_ROOT,
        permissionMode: 'bypassPermissions',
        settingSources: ['project', 'user'],
      },
    })
    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        fullText = event.result ?? ''
      }
    }
    return fullText.trim()
  }

  private loopCheck(eventSig: string): boolean {
    if (eventSig === this.loopLastSignature) {
      this.loopRepeatCount++
      return this.loopRepeatCount >= LOOP_THRESHOLD
    }
    this.loopLastSignature = eventSig
    this.loopRepeatCount = 1
    return false
  }

  private loopReset(): void {
    this.loopLastSignature = ''
    this.loopRepeatCount = 0
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { onTyping, onPartial, onToolProgress } = options
    const cwd = options.workingDirectory ?? PROJECT_ROOT
    let lastError: unknown

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
        logger.info({ attempt, delay }, 'Retrying after transient error')
        await sleep(delay)
      }

      let responseText: string | null = null
      let newSessionId: string | undefined
      let streamedText = ''

      const typingInterval = onTyping ? setInterval(onTyping, 4000) : null

      try {
        this.loopReset()
        logger.info({ attempt }, 'Starting agent query')
        const conversation = query({
          prompt: options.message,
          options: {
            model: resolveModel(),
            cwd,
            permissionMode: 'bypassPermissions',
            settingSources: ['project', 'user'],
            includePartialMessages: Boolean(onPartial),
            ...(options.sessionId ? { resume: options.sessionId } : {}),
          },
        })
        logger.info('Query object created, iterating events')

        for await (const event of conversation) {
          logger.info({ type: event.type, subtype: (event as any).subtype }, 'Agent event')
          if (event.type === 'system' && event.subtype === 'init') {
            newSessionId = event.session_id
          }

          // Loop guard: detect repeated identical tool invocations
          // tool_use_summary fires after each tool completes with name + result summary
          if (event.type === 'tool_use_summary' || event.type === 'tool_progress') {
            const ev = event as any
            const toolName = ev.tool_name ?? ev.name ?? ''
            const toolStatus = (ev.summary ?? ev.message ?? '').slice(0, 100)
            const sig = JSON.stringify({ t: event.type, n: toolName, s: toolStatus })
            if (this.loopCheck(sig)) {
              logger.error({ signature: sig, count: LOOP_THRESHOLD }, 'Loop detected: identical tool calls repeated, aborting')
              return {
                text: `Loop detected: the agent repeated the same tool call ${LOOP_THRESHOLD} times after context overflow. Aborting to prevent infinite loop. Try rephrasing or starting a /newchat.`,
                newSessionId,
              }
            }
            // Emit tool progress for streaming previews (OpenClaw v2026.5.19)
            if (onToolProgress && toolName) {
              onToolProgress(toolName, toolStatus)
            }
          }

          if (onPartial && event.type === 'stream_event') {
            const ev: any = (event as any).event
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              streamedText += ev.delta.text
              onPartial(streamedText)
            }
          }

          if (event.type === 'result' && event.subtype === 'success') {
            responseText = event.result ?? null
            logger.info({ length: responseText?.length }, 'Agent result received')
          } else if (event.type === 'result') {
            logger.warn({ subtype: event.subtype }, 'Agent returned non-success result')
          }
        }
        logger.info('Event loop ended')

        // If a steer message was queued during this run, chain it as a follow-up
        if (this.pendingSteer && newSessionId) {
          const steerMsg = `[steer]: ${this.pendingSteer}`
          this.pendingSteer = null
          logger.info('Executing queued steer message')
          return this.run({
            message: steerMsg,
            sessionId: newSessionId,
            workingDirectory: options.workingDirectory,
            onTyping,
            onPartial,
            onToolProgress,
          })
        }
        this.pendingSteer = null

        // Reply reconciliation: if no success result arrived but the model streamed
        // text before the turn died, surface the partial instead of "(no response)".
        // The user sees what the agent had, tagged so they know it was cut short.
        if (!responseText && streamedText.trim().length > 0) {
          logger.warn({ partialLength: streamedText.length }, 'Reconciling partial stream as response')
          responseText = `${streamedText.trim()}\n\n_(partial reply, turn ended without a final result)_`
        }

        // Success, return the result
        return { text: responseText, newSessionId }
      } catch (err) {
        lastError = err
        logger.error({ err, attempt }, 'Agent query failed')

        if (attempt < MAX_RETRIES && isRetryableError(err)) {
          continue // retry
        }

        // Non-retryable or exhausted retries
        return {
          text: 'API is temporarily overloaded. Will try again on the next run.',
          newSessionId: undefined,
        }
      } finally {
        if (typingInterval) clearInterval(typingInterval)
      }
    }

    // Should not reach here, but just in case
    logger.error({ lastError }, 'Exhausted all retries')
    return {
      text: 'API is temporarily overloaded. Will try again on the next run.',
      newSessionId: undefined,
    }
  }
}
