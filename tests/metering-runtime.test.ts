import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { UsageMeter } from '../src/metering.js'
import { SessionStore } from '../src/runtime/ai-sdk/sessions.js'

describe('AiSdkAgentRuntime usage metering', () => {
  it('records token usage for a completed turn', async () => {
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')

    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            { type: 'text-delta' as const, id: 't1', delta: 'hi' },
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: 'stop' as const,
              // LanguageModelV3Usage shape (nested); the app layer flattens it.
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 2, text: 2, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    })

    const meter = new UsageMeter(new Database(':memory:'))
    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const runtime = new AiSdkAgentRuntime(new SessionStore(new Database(':memory:')), model as never, meter)
    const result = await runtime.run({ message: 'hello' })
    expect(result.text).toBe('hi')

    const rows = meter.summary()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      runs: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      provider: 'override',
    })
  })
})
