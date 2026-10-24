/**
 * tests/ai-sdk-cancel-delegation.test.ts
 *
 * Card #232: in the ai-sdk runtime a cancel reaches delegated work. The
 * subagent gets the parent's abort signal and is gated under the parent's
 * session; the bash tool kills what its shell started, not just the shell.
 *
 * ToolLoopAgent is mocked (as in ai-sdk-subagent.test.ts) so this exercises
 * the runtime's wiring; the gate is spied on to see which session it is given.
 * The run-level abort contract is in tests/ai-sdk-cancel.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

type Captured = { tools: Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }> }
const h = vi.hoisted(() => ({
  captured: [] as Captured[],
  generateCalls: [] as Array<{ prompt: string; abortSignal?: AbortSignal }>,
  generate: null as null | ((args: { prompt: string; abortSignal?: AbortSignal }) => Promise<{ text: string }>),
  gate: vi.fn((_c: { session: string; tool: string }) => ({ allow: true as const })),
}))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    ToolLoopAgent: vi.fn().mockImplementation((opts: Captured) => {
      h.captured.push(opts)
      return {
        generate: vi.fn(async (args: { prompt: string; abortSignal?: AbortSignal }) => {
          h.generateCalls.push(args)
          return h.generate ? h.generate(args) : { text: 'report' }
        }),
        stream: vi.fn(async () => ({
          fullStream: (async function* () {})(),
          response: Promise.resolve({ messages: [] }),
          text: Promise.resolve('reply'),
        })),
      }
    }),
  }
})
vi.mock('../src/runtime/ai-sdk/mcp.js', () => ({ loadMcpTools: vi.fn(async () => ({})) }))
vi.mock('../src/assurance/scope-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/assurance/scope-gate.js')>()),
  gateToolCall: h.gate,
  resolveRole: () => null,
}))

class FakeDb {
  private rows = new Map<string, string>()
  exec(_sql: string): void {}
  prepare(sql: string) {
    if (/SELECT/i.test(sql)) return { get: (id: string) => (this.rows.has(id) ? { messages: this.rows.get(id)! } : undefined) }
    return { run: (id: string, messages: string) => { this.rows.set(id, messages) } }
  }
}

let AiSdkAgentRuntime: typeof import('../src/runtime/ai-sdk/index.js')['AiSdkAgentRuntime']
let SessionStore: typeof import('../src/runtime/ai-sdk/sessions.js')['SessionStore']
let createTools: typeof import('../src/runtime/ai-sdk/tools.js')['createTools']

beforeAll(async () => {
  ;({ AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js'))
  ;({ SessionStore } = await import('../src/runtime/ai-sdk/sessions.js'))
  ;({ createTools } = await import('../src/runtime/ai-sdk/tools.js'))
})

afterEach(() => {
  h.captured.length = 0
  h.generateCalls.length = 0
  h.generate = null
  h.gate.mockClear()
})

async function topLevelTools() {
  const runtime = new AiSdkAgentRuntime(new SessionStore(new FakeDb() as never), {} as never)
  await runtime.run({ message: 'hi', sessionId: 'parent-session' })
  return h.captured[0].tools
}

describe('subagents under cancellation', () => {
  it('a subagent gets the abort signal its parent was given', async () => {
    const tools = await topLevelTools()
    const ctrl = new AbortController()
    await tools.dispatch_subagent.execute!({ prompt: 'look into it' }, { abortSignal: ctrl.signal })
    expect(h.generateCalls).toHaveLength(1)
    expect(h.generateCalls[0].abortSignal).toBe(ctrl.signal)
  })

  it('a subagent stopped by a cancel says so rather than reporting a failure', async () => {
    const tools = await topLevelTools()
    const ctrl = new AbortController()
    h.generate = ({ abortSignal }) => new Promise((_res, rej) => {
      // Like the AI SDK: an already-aborted signal fails at once.
      if (abortSignal?.aborted) return rej(new Error('This operation was aborted'))
      abortSignal?.addEventListener('abort', () => rej(new Error('This operation was aborted')))
    })
    const pending = tools.dispatch_subagent.execute!({ prompt: 'long task' }, { abortSignal: ctrl.signal })
    ctrl.abort()
    await expect(pending).resolves.toBe('Subagent stopped: the run was cancelled.')
  })

  it("a subagent's tool calls are gated under the parent's session", async () => {
    const tools = await topLevelTools()
    await tools.dispatch_subagent.execute!({ prompt: 'x' }, {})
    const subTools = h.captured[1].tools
    expect(subTools.dispatch_subagent).toBeUndefined()
    await subTools.read_file.execute!({ path: '/nonexistent' }, {})
    await tools.read_file.execute!({ path: '/nonexistent' }, {})
    const sessions = h.gate.mock.calls.filter(([c]) => c.tool === 'read_file').map(([c]) => c.session)
    expect(sessions).toEqual(['parent-session', 'parent-session'])
  })
})

describe.skipIf(process.platform === 'win32')('bash under cancellation', () => {
  it('a cancel kills the shell and what it started, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cancel-'))
    const pidFile = join(dir, 'pid')
    const bash = createTools(dir).bash
    const ctrl = new AbortController()
    const started = Date.now()
    const pending = bash.execute!({ command: `sleep 30 & echo $! > ${pidFile}; wait` }, { abortSignal: ctrl.signal, toolCallId: 't', messages: [] })
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20))
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(pid).toBeGreaterThan(0)
    ctrl.abort()
    await expect(pending).resolves.toBe('cancelled: the run was stopped')
    expect(Date.now() - started).toBeLessThan(10_000)
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('a timeout also takes the whole group down, and says it timed out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-timeout-'))
    const pidFile = join(dir, 'pid')
    const out = await createTools(dir).bash.execute!({ command: `sleep 30 & echo $! > ${pidFile}; wait`, timeout_ms: 500 }, { toolCallId: 't', messages: [] })
    expect(out).toMatch(/^exit code: \d+ \(timed out\)/)
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('a command after the cancel does not start', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await createTools(tmpdir()).bash.execute!({ command: 'echo should-not-run' }, { abortSignal: ctrl.signal, toolCallId: 't', messages: [] })
    expect(out).toMatch(/^cancelled/)
  })
})
