/**
 * What one agent turn is about and what its tools read (card #235).
 *
 * runAgent runs each turn inside this context. The tool-evidence path (the
 * Claude PostToolUse hook and the ai-sdk tool wrapper, through
 * recordToolEvidence) notes the evidence types every successful call shows,
 * so the turn's memory can be marked untrusted when it read mail or the web.
 * The chat id lets a subagent brief carry that chat's pinned decisions.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

type TurnContext = { chatId?: string; reads: Set<string> }

const store = new AsyncLocalStorage<TurnContext>()

export async function withTurn<T>(chatId: string | undefined, fn: () => Promise<T>): Promise<{ result: T; reads: string[] }> {
  const ctx: TurnContext = { chatId, reads: new Set() }
  const result = await store.run(ctx, fn)
  return { result, reads: [...ctx.reads] }
}

/** Record evidence types a successful tool call showed. No-op outside a turn. */
export function noteReads(types: readonly string[]): void {
  const ctx = store.getStore()
  if (ctx) for (const t of types) ctx.reads.add(t)
}

/** The chat this turn belongs to, if any. */
export function turnChat(): string | undefined {
  return store.getStore()?.chatId
}
