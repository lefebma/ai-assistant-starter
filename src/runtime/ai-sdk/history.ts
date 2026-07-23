/**
 * Prompt-cache breakpoints and history budgeting for the AI SDK runtime.
 *
 * The ai-sdk lane bills the API directly, and the ToolLoopAgent sends one
 * request per step, replaying the full conversation each time. Without
 * cache_control breakpoints Anthropic bills every one of those replays at
 * full input price; with them, the stable prefix bills at ~0.1x. Two
 * breakpoints do the work (Anthropic allows 4 per request):
 *
 *   1. The system message — Anthropic renders tools -> system -> messages,
 *      so a breakpoint on the system block caches the tool schemas and
 *      system prompt together. Set once in buildAgent via cachedSystem().
 *   2. The newest message of each step — moved forward every step via the
 *      agent's prepareStep hook (withCacheBreakpoint), so each request in
 *      the tool loop re-reads the previous step's prefix.
 *
 * Non-Anthropic providers (Phase 3: openai, google) ignore the 'anthropic'
 * providerOptions namespace, so the markers are inert there.
 *
 * trimHistory() bounds the replayed conversation. It uses a high/low
 * watermark: nothing happens until the serialized history exceeds the max,
 * then it drops down to ~60% in one cut. Trimming in chunks (instead of a
 * rolling window) keeps the message prefix byte-stable between cuts, which
 * is what lets breakpoint 2 actually hit cache turn after turn. Cuts land
 * on a plain user turn — resuming at an 'assistant' or 'tool' message would
 * orphan a tool_use/tool_result pairing and 400 the request.
 */
import type { ModelMessage, SystemModelMessage } from 'ai'
import { readEnvFile } from '../../env.js'

const EPHEMERAL = { type: 'ephemeral' as const }

/** Serialized-history high watermark (bytes, ~4 chars per token). */
const DEFAULT_MAX_BYTES = 200_000

/** Where a trim cuts down to, as a fraction of the max. */
const LOW_WATERMARK_RATIO = 0.6

export function historyMaxBytes(): number {
  const env = readEnvFile()
  const raw = env['AI_HISTORY_MAX_BYTES']?.trim() || process.env['AI_HISTORY_MAX_BYTES']?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES
}

/** System prompt as a cache-breakpointed system message (breakpoint 1). */
export function cachedSystem(content: string): SystemModelMessage {
  return {
    role: 'system',
    content,
    providerOptions: { anthropic: { cacheControl: EPHEMERAL } },
  }
}

/**
 * Returns a copy of `messages` whose last message carries a cache
 * breakpoint (breakpoint 2). The input array and its messages are never
 * mutated — persisted history stays free of cache markers. Existing
 * providerOptions on the last message (e.g. Anthropic reasoning
 * signatures) are preserved.
 */
export function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]
  const anthropic = (last.providerOptions?.['anthropic'] ?? {}) as Record<string, unknown>
  const marked = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: { ...anthropic, cacheControl: EPHEMERAL },
    },
  } as ModelMessage
  return [...messages.slice(0, -1), marked]
}

/**
 * Bounds a loaded session history to `maxBytes` of serialized JSON.
 * Under the watermark the input array is returned untouched (reference
 * equality — callers can detect a trim by comparing lengths). Over it,
 * the oldest messages are dropped down to the low watermark, then the cut
 * advances to the next plain user turn. If no user turn exists past the
 * cut, the slice from the last user turn is kept whole even when it
 * exceeds the budget — correctness over budget.
 */
export function trimHistory(messages: ModelMessage[], maxBytes = historyMaxBytes()): ModelMessage[] {
  if (messages.length === 0) return messages

  const sizes = messages.map(m => JSON.stringify(m).length)
  let total = sizes.reduce((a, b) => a + b, 0)
  if (total <= maxBytes) return messages

  const low = Math.floor(maxBytes * LOW_WATERMARK_RATIO)
  let start = 0
  while (start < messages.length - 1 && total > low) {
    total -= sizes[start]
    start++
  }
  while (start < messages.length && messages[start].role !== 'user') start++

  if (start >= messages.length) {
    const lastUser = messages.map(m => m.role).lastIndexOf('user')
    start = lastUser >= 0 ? lastUser : 0
  }
  return messages.slice(start)
}
