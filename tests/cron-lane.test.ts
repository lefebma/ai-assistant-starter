import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getRuntimeSpy, runSpy } = vi.hoisted(() => {
  const runSpy = vi.fn(async () => ({ text: 'ok', newSessionId: 's1' }))
  const getRuntimeSpy = vi.fn((_lane?: string, _id?: string) => ({ run: runSpy, steer: vi.fn() }))
  return { getRuntimeSpy, runSpy }
})

vi.mock('../src/runtime/index.js', () => ({
  getAgentRuntime: getRuntimeSpy,
  // The turn's runtime for a chat's /model choice (card #270): the lane's own here.
  resolveTurnRuntime: (lane: string) => ({ id: `${lane}-runtime`, model: undefined }),
}))

import { runAgent } from '../src/agent.js'

beforeEach(() => {
  getRuntimeSpy.mockClear()
  runSpy.mockClear()
})

describe('runAgent lane routing', () => {
  it('defaults to the chat lane', async () => {
    await runAgent('hello')
    expect(getRuntimeSpy).toHaveBeenCalledWith('chat', 'chat-runtime')
  })

  it('forwards the cron lane to the runtime selector', async () => {
    await runAgent('scheduled work', undefined, undefined, undefined, undefined, 'cron')
    expect(getRuntimeSpy).toHaveBeenCalledWith('cron', 'cron-runtime')
  })
})
