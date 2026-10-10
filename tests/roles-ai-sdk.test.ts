/**
 * tests/roles-ai-sdk.test.ts
 *
 * Card #195 on the ai-sdk runtime: a scoped run is only offered its role's
 * tools, in-role calls run, out-of-role commands are refused without running,
 * and an undefined role does not start.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })
process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'havn-roles-ai-'))

type Captured = { tools: Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }> }
let captured: Captured[] = []

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    ToolLoopAgent: vi.fn().mockImplementation((opts: Captured) => {
      captured.push(opts)
      return {
        generate: vi.fn(async () => ({ text: '' })),
        stream: vi.fn(async () => ({ fullStream: (async function* () {})(), response: Promise.resolve({ messages: [] }), text: Promise.resolve('') })),
      }
    }),
  }
})

const browserExecute = vi.fn(async () => 'browser-result')
vi.mock('../src/runtime/ai-sdk/mcp.js', () => ({
  loadMcpTools: vi.fn(async () => ({ mcp__playwright__browser_navigate: { description: 'nav', execute: browserExecute } })),
}))

class FakeDb {
  private rows = new Map<string, string>()
  exec(): void {}
  prepare(sql: string) {
    if (/SELECT/i.test(sql)) return { get: (id: string) => (this.rows.has(id) ? { messages: this.rows.get(id)! } : undefined) }
    return { run: (id: string, messages: string) => { this.rows.set(id, messages) } }
  }
}

let AiSdkAgentRuntime: typeof import('../src/runtime/ai-sdk/index.js')['AiSdkAgentRuntime']
let SessionStore: typeof import('../src/runtime/ai-sdk/sessions.js')['SessionStore']
beforeAll(async () => {
  ;({ AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js'))
  ;({ SessionStore } = await import('../src/runtime/ai-sdk/sessions.js'))
})

const runtime = () => new AiSdkAgentRuntime(new SessionStore(new FakeDb() as any), {} as any)

describe('scoped ai-sdk runs', () => {
  it('offers only the role\'s tools: no writes, no browser, no subagents for inbox-triage', async () => {
    captured = []
    await runtime().run({ message: 'triage', scope: { role: 'inbox-triage', taskId: 't1' } })
    const names = Object.keys(captured[0].tools).sort()
    expect(names).toEqual(['bash', 'read_file'])
  })

  it('runs in-role commands and refuses others without running them', async () => {
    captured = []
    await runtime().run({ message: 'triage', scope: { role: 'inbox-triage', taskId: 't1' } })
    const bash = captured[0].tools.bash.execute!
    expect(String(await bash({ command: 'echo in-role' }, {}))).toContain('in-role')
    const refused = String(await bash({ command: 'echo x && rm -rf output' }, {}))
    expect(refused).toMatch(/^Refused: this scheduled job runs with the inbox-triage role/)
    expect(refused).toContain('/schedule role t1')
  })

  it('applies argument limits to MCP tools in a role that has them', async () => {
    captured = []
    browserExecute.mockClear()
    await runtime().run({ message: 'research', scope: { role: 'research' } })
    const nav = captured[0].tools.mcp__playwright__browser_navigate.execute!
    expect(await nav({ url: 'https://example.com' }, {})).toBe('browser-result')
    expect(String(await nav({ url: 'file:///etc/passwd' }, {}))).toContain('Refused')
    expect(browserExecute).toHaveBeenCalledTimes(1)
  })

  it('an unscoped run is offered every tool, as before', async () => {
    captured = []
    await runtime().run({ message: 'chat' })
    expect(Object.keys(captured[0].tools)).toEqual(expect.arrayContaining(['bash', 'read_file', 'write_file', 'edit_file', 'mcp__playwright__browser_navigate', 'dispatch_subagent']))
  })

  it('does not start a run whose role is not defined', async () => {
    captured = []
    const r = await runtime().run({ message: 'x', scope: { role: 'nope', taskId: 'q9' } })
    expect(r.text).toContain('Not run: role "nope" is not defined')
    expect(captured).toHaveLength(0)
  })
})
