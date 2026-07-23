/**
 * ClaudeAgentRuntime — the Claude Agent SDK behind the AgentRuntime interface.
 *
 * Moved verbatim from src/agent.ts in Phase 1 of the LLM-agnostic plan.
 * This is the only file in the codebase that may import
 * @anthropic-ai/claude-agent-sdk.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'
import { getSecret } from '../vault/index.js'
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
  const env = readEnvFile()
  return env.AGENT_MODEL?.trim() || process.env.AGENT_MODEL?.trim() || DEFAULT_MODEL
}

function isRetryableError(err: unknown): boolean {
  const msg = String(err)
  // 529 = overloaded, 429 = rate limited, 503 = service unavailable
  return /\b(529|overloaded)\b/i.test(msg)
    || /\b(429|rate.?limit)\b/i.test(msg)
    || /\b(503|service.?unavailable)\b/i.test(msg)
}

/**
 * Subscription usage-window exhaustion, as opposed to a transient 429/529.
 * The structured `rate_limit_event` (status 'rejected') is the primary signal;
 * this text classifier is a fallback for auth paths that surface the window as a
 * thrown exception. Matches "usage limit" specifically so it never overlaps with
 * isRetryableError's transient "rate limit" (which should backoff, not escalate).
 */
function isUsageLimitError(err: unknown): boolean {
  return /usage limit/i.test(String(err))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * OpenClaw v2026.6.5: coerce MCP tool result artifacts in agent response text.
 * Some MCP servers return non-string payloads that the model echoes as
 * "[object Object]" or leaks raw `{"type":"text","text":"..."}` wrappers.
 * This filter cleans the response before it reaches the user.
 */
function coerceMcpResult(text: string): string {
  // Replace literal "[object Object]" (leaked non-string tool result)
  let result = text.replace(/\[object Object\]/g, '(tool returned non-text result)')

  // Unwrap MCP content-block wrappers that leaked into prose:
  // e.g. {"type":"text","text":"actual content"} sitting on its own line
  result = result.replace(
    /^\s*\{"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"(.+?)"\s*\}\s*$/gm,
    (_match, inner) => {
      try {
        // Unescape JSON string escapes
        return JSON.parse(`"${inner}"`)
      } catch {
        return inner
      }
    }
  )

  return result
}

/** Result of a single-lane run. `usageLimitHit` tells the caller to escalate. */
type LaneOutcome = {
  text: string | null
  newSessionId?: string
  usageLimitHit?: boolean
  rateLimitType?: string
  resetsAt?: number
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = 'claude'

  /** Pending steer message: injected as the next prompt after current run completes */
  private pendingSteer: string | null = null

  // OpenClaw v2026.5.28: track active subagent workspaces to detect conflicts
  private readonly activeWorkspaces = new Map<string, string>() // sessionId -> cwd

  private loopLastSignature = ''
  private loopRepeatCount = 0

  steer(message: string): void {
    this.pendingSteer = message
    logger.info({ steer: message.slice(0, 100) }, 'Steer message queued')
  }

  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return this.activeWorkspaces
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

  /**
   * Run one full agent turn with subscription→API overflow (Option A).
   *
   * Runs the turn on the default subscription lane. If the subscription usage
   * window is exhausted (rate_limit_event rejected, or a thrown usage-limit error)
   * AND an ANTHROPIC_API_KEY is set in .env, transparently re-runs the same turn on
   * API billing — resuming the session the subscription lane created so the
   * conversation history carries over intact. With no key configured, it returns a
   * clear message instead of a silent stall.
   *
   * `onLaneSwitch` fires once, only when the overflow lane actually engages, so a
   * surface (e.g. Telegram) can tell the user the reply is on paid billing. It is
   * NOT called for warnings, transient retries, or the normal subscription path.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    // BYOK: the overflow key resolves through the vault, then .env, then env.
    const overflowKey = getSecret('ANTHROPIC_API_KEY')
    const cwd = options.workingDirectory ?? PROJECT_ROOT

    const primary = await this.runOnLane(options, options.sessionId, cwd, undefined)

    if (!primary.usageLimitHit) {
      return { text: primary.text, newSessionId: primary.newSessionId }
    }

    // Subscription window exhausted from here down.
    if (!overflowKey) {
      logger.warn({ rateLimitType: primary.rateLimitType }, 'Usage window hit but no ANTHROPIC_API_KEY overflow lane configured')
      const window = primary.rateLimitType ? ` (${primary.rateLimitType})` : ''
      return {
        text: `Claude usage window hit${window}. No overflow lane is configured, so I can't fall back to API billing. Add ANTHROPIC_API_KEY to .env to keep going when the subscription window is exhausted.`,
        newSessionId: primary.newSessionId,
      }
    }

    logger.warn(
      { rateLimitType: primary.rateLimitType, resetsAt: primary.resetsAt },
      'Subscription usage window exhausted; engaging ANTHROPIC_API_KEY overflow lane'
    )
    options.onLaneSwitch?.({ rateLimitType: primary.rateLimitType, resetsAt: primary.resetsAt })

    // Resume the session the subscription lane created so history carries over.
    const resumeId = primary.newSessionId ?? options.sessionId
    const fallback = await this.runOnLane(options, resumeId, cwd, overflowKey)
    return { text: fallback.text, newSessionId: fallback.newSessionId ?? primary.newSessionId }
  }

  /**
   * Run one agent turn on a single billing lane.
   *
   * `apiKeyOverride` scopes an ANTHROPIC_API_KEY to this subprocess only (via the
   * SDK's per-call `env` option), so the overflow lane never mutates global
   * process.env and can't race a concurrent subscription-lane run. When omitted,
   * the CLI uses the default subscription auth from ~/.claude.
   *
   * Sets `usageLimitHit` only when the subscription window is *rejected* (not a
   * mere warning), so the caller can escalate to the API lane. A transient 429/529
   * is handled here by backoff and does NOT set usageLimitHit.
   */
  private async runOnLane(
    options: AgentRunOptions,
    sessionId: string | undefined,
    cwd: string,
    apiKeyOverride?: string
  ): Promise<LaneOutcome> {
    const { onTyping, onPartial, onToolProgress } = options
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
      let usageLimitHit = false
      let rateLimitType: string | undefined
      let resetsAt: number | undefined

      const typingInterval = onTyping ? setInterval(onTyping, 4000) : null

      try {
        this.loopReset()
        logger.info({ attempt, cwd, lane: apiKeyOverride ? 'api' : 'subscription' }, 'Starting agent query')
        const conversation = query({
          prompt: options.message,
          options: {
            model: resolveModel(),
            cwd,
            permissionMode: 'bypassPermissions',
            settingSources: ['project', 'user'],
            includePartialMessages: Boolean(onPartial),
            ...(sessionId ? { resume: sessionId } : {}),
            // Overflow lane: scope the API key to THIS subprocess only. Spread
            // process.env so HOME/PATH/etc still reach the CLI; the explicit key
            // makes it bill against the API instead of the subscription window.
            ...(apiKeyOverride ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKeyOverride } } : {}),
          },
        })
        logger.info('Query object created, iterating events')

        for await (const event of conversation) {
          logger.info({ type: event.type, subtype: (event as any).subtype }, 'Agent event')
          if (event.type === 'system' && event.subtype === 'init') {
            newSessionId = event.session_id
            // Track workspace for subagent conflict detection
            if (newSessionId) this.activeWorkspaces.set(newSessionId, cwd)
          }

          // Subscription usage-window signal (claude.ai auth). status 'rejected'
          // means the window is exhausted and this turn is blocked — distinct from
          // a transient 429/529. 'allowed_warning' is only an approaching-limit
          // heads-up and must NOT trigger escalation.
          if (event.type === 'rate_limit_event') {
            const info = (event as any).rate_limit_info
            if (info?.status === 'rejected') {
              usageLimitHit = true
              rateLimitType = info.rateLimitType
              resetsAt = info.resetsAt
              logger.warn({ rateLimitType, resetsAt }, 'Subscription rate limit rejected')
            }
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

        // Subscription window rejected with no usable turn: bubble up so the caller
        // can escalate to the API lane. Skip the steer/partial paths — there's no
        // real answer here to reconcile or follow up on.
        if (usageLimitHit && !responseText) {
          if (newSessionId) this.activeWorkspaces.delete(newSessionId)
          return { text: null, newSessionId, usageLimitHit, rateLimitType, resetsAt }
        }

        // If a steer message was queued during this run, chain it as a follow-up
        if (this.pendingSteer && newSessionId) {
          const steerMsg = `[steer]: ${this.pendingSteer}`
          this.pendingSteer = null
          logger.info('Executing queued steer message')
          // Go through the public entry so a steered follow-up also gets overflow.
          const steered = await this.run({
            message: steerMsg,
            sessionId: newSessionId,
            workingDirectory: cwd,
            onTyping,
            onPartial,
            onToolProgress,
          })
          return { text: steered.text, newSessionId: steered.newSessionId ?? newSessionId }
        }
        this.pendingSteer = null

        // Clean up workspace tracking
        if (newSessionId) this.activeWorkspaces.delete(newSessionId)

        // OpenClaw v2026.6.9: reply reconciliation.
        // If no success result arrived but the model streamed text before the turn died,
        // surface the partial instead of "(no response)". The user sees what the agent
        // had, tagged so they know it was cut short.
        if (!responseText && streamedText.trim().length > 0) {
          logger.warn({ partialLength: streamedText.length }, 'Reconciling partial stream as response')
          responseText = `${streamedText.trim()}\n\n_(partial reply, turn ended without a final result)_`
        }

        // OpenClaw v2026.6.5: coerce MCP tool result artifacts that leak into response text.
        // Some MCP servers return non-string payloads (objects, arrays) that the model echoes
        // verbatim as "[object Object]" or raw JSON blobs. Clean before delivery.
        if (responseText) {
          responseText = coerceMcpResult(responseText)
        }

        // Success, return the result
        return { text: responseText, newSessionId }
      } catch (err) {
        lastError = err
        logger.error({ err, attempt }, 'Agent query failed')

        // The turn's real answer arrived before the subprocess died: the CLI emitted a
        // success result, then exited non-zero on teardown (observed with claude 2.1.204,
        // which crashed on shutdown after every turn). The SDK surfaces the non-zero exit
        // as a throw — but the answer is already in hand, so deliver it instead of binning
        // a good reply behind a generic error.
        if (responseText) {
          logger.warn({ attempt }, 'Result received before subprocess error; delivering it anyway')
          return { text: coerceMcpResult(responseText), newSessionId }
        }
        // Same call for a partial stream: a truncated real answer beats a fabricated one.
        if (streamedText.trim().length > 0) {
          logger.warn({ attempt, partialLength: streamedText.length }, 'Partial stream before subprocess error; delivering it')
          return { text: `${streamedText.trim()}\n\n_(partial reply, turn ended early)_`, newSessionId }
        }

        // A thrown usage-limit error (some auth paths surface the exhausted window
        // as an exception, not a rate_limit_event) escalates instead of backing off.
        if (isUsageLimitError(err)) {
          return { text: null, usageLimitHit: true }
        }

        if (attempt < MAX_RETRIES && isRetryableError(err)) {
          continue // retry
        }

        // Genuinely a transient upstream overload/rate-limit that outlived our retries:
        // keep the exact wording the scheduler keys off (OVERLOAD_PATTERN) to defer.
        if (isRetryableError(err)) {
          return { text: 'API is temporarily overloaded. Will try again on the next run.' }
        }

        // Anything else is a real, non-transient failure (subprocess crash, bad config,
        // MCP error). Surface it truthfully instead of mislabeling it as an API overload.
        const detail = String((err as any)?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 300)
        return { text: `Ran into an error and couldn't finish that: ${detail}` }
      } finally {
        if (typingInterval) clearInterval(typingInterval)
      }
    }

    // Should not reach here (retryable errors return above; the loop never exhausts
    // without a return), but stay honest if it somehow does.
    logger.error({ lastError }, 'Exhausted all retries')
    return { text: 'API is temporarily overloaded. Will try again on the next run.' }
  }
}
