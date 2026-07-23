/**
 * tests/ai-sdk-runtime.test.ts
 * Offline coverage for the AI SDK runtime building blocks (Phase 2):
 * - SessionStore roundtrip against an in-memory SQLite db
 * - buildSystemPrompt assembly (project CLAUDE.md + environment block)
 * - createTools semantics: bash exec, read/write/edit including the
 *   unique-match contract that mirrors Claude Code's Edit tool
 * - factory registration of the 'ai-sdk' runtime
 *
 * The live agent loop (model calls) is covered by scripts/ai-sdk-smoke.ts,
 * not here — no network in unit tests.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/runtime/ai-sdk/sessions.js'
import { buildSystemPrompt } from '../src/runtime/ai-sdk/prompt.js'
import { createTools } from '../src/runtime/ai-sdk/tools.js'
import { getAgentRuntime, setAgentRuntime } from '../src/runtime/index.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  setAgentRuntime(null)
  delete process.env.AGENT_RUNTIME
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Structural fake for better-sqlite3 (repo convention: vitest never loads
 * the native module — see tests/scheduler-db.test.ts). Implements exactly
 * the surface SessionStore uses: exec, prepare().get, prepare().run with
 * upsert-by-id semantics. The real SQL runs live via scripts/ai-sdk-smoke.ts.
 */
class FakeDb {
  private rows = new Map<string, string>()
  exec(_sql: string): void {}
  prepare(sql: string) {
    if (/SELECT/i.test(sql)) {
      return {
        get: (id: string) => (this.rows.has(id) ? { messages: this.rows.get(id)! } : undefined),
      }
    }
    return {
      run: (id: string, messages: string, _updatedAt: number) => {
        this.rows.set(id, messages)
      },
    }
  }
}

function fakeStore(): SessionStore {
  return new SessionStore(new FakeDb() as any)
}

describe('SessionStore', () => {
  it('roundtrips messages and returns null for unknown ids', () => {
    const store = fakeStore()
    expect(store.load('nope')).toBeNull()

    const id = store.newSessionId()
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ]
    store.save(id, messages)
    expect(store.load(id)).toEqual(messages)
  })

  it('overwrites on re-save (upsert)', () => {
    const store = fakeStore()
    const id = store.newSessionId()
    store.save(id, [{ role: 'user', content: 'v1' }])
    store.save(id, [{ role: 'user', content: 'v1' }, { role: 'assistant', content: 'v2' }])
    expect(store.load(id)).toHaveLength(2)
  })

  it('mints unique session ids', () => {
    const store = fakeStore()
    expect(store.newSessionId()).not.toBe(store.newSessionId())
  })
})

describe('buildSystemPrompt', () => {
  it('includes project CLAUDE.md content and the environment block', () => {
    const root = tempDir()
    writeFileSync(join(root, 'CLAUDE.md'), '# Test Project\nAlways answer in haiku.')
    const prompt = buildSystemPrompt(root)
    expect(prompt).toContain('Always answer in haiku.')
    expect(prompt).toContain('# Project instructions')
    expect(prompt).toContain(`Working directory: ${root}`)
    expect(prompt).toContain('America/Toronto')
  })

  it('omits the project section when no CLAUDE.md exists', () => {
    const root = tempDir()
    const prompt = buildSystemPrompt(root)
    expect(prompt).not.toContain('# Project instructions')
    expect(prompt).toContain('persistent personal assistant')
  })
})

describe('createTools', () => {
  it('bash executes in the given cwd and reports progress', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const progress: string[] = []
    const tools = createTools(dir, (name, status) => progress.push(`${name}:${status}`))
    const out = await (tools.bash as any).execute({ command: 'ls' }, {} as any)
    expect(out).toContain('marker.txt')
    expect(progress[0]).toBe('bash:ls')
  })

  it('bash surfaces non-zero exit codes with stderr', async () => {
    const tools = createTools(tempDir())
    const out = await (tools.bash as any).execute({ command: 'ls /definitely/not/a/path' }, {} as any)
    expect(out).toContain('exit code:')
    expect(out.toLowerCase()).toContain('no such file')
  })

  it('write_file then read_file roundtrips, creating parent dirs', async () => {
    const dir = tempDir()
    const tools = createTools(dir)
    await (tools.write_file as any).execute({ path: 'nested/deep/file.txt', content: 'hello world' }, {} as any)
    const content = await (tools.read_file as any).execute({ path: 'nested/deep/file.txt' }, {} as any)
    expect(content).toBe('hello world')
  })

  it('edit_file enforces the unique-match contract', async () => {
    const dir = tempDir()
    const tools = createTools(dir)
    writeFileSync(join(dir, 'f.txt'), 'aaa bbb aaa')

    const notFound = await (tools.edit_file as any).execute(
      { path: 'f.txt', old_string: 'zzz', new_string: 'y' }, {} as any)
    expect(notFound).toContain('not found')

    const ambiguous = await (tools.edit_file as any).execute(
      { path: 'f.txt', old_string: 'aaa', new_string: 'y' }, {} as any)
    expect(ambiguous).toContain('matches 2 times')

    await (tools.edit_file as any).execute(
      { path: 'f.txt', old_string: 'aaa', new_string: 'ccc', replace_all: true }, {} as any)
    expect(readFileSync(join(dir, 'f.txt'), 'utf-8')).toBe('ccc bbb ccc')
  })

  it('read_file returns an error message for missing files', async () => {
    const tools = createTools(tempDir())
    const out = await (tools.read_file as any).execute({ path: 'missing.txt' }, {} as any)
    expect(out).toContain('Error reading file')
  })
})

/**
 * Defect found during Phase 2 review: edit_file's default (non-replace_all)
 * path does `content.replace(old_string, new_string)` with two plain
 * strings. JavaScript's String.prototype.replace still honors special
 * replacement patterns ($&, $`, $', $$) in the *replacement* argument even
 * when the search argument is a literal string, not a RegExp. So a
 * new_string containing "$&" (or "$`", "$'", "$$") gets silently corrupted
 * instead of inserted verbatim -- real behavior drift from the Claude Code
 * Edit tool contract this module's header claims to mirror ("edit requires
 * a unique match... semantics deliberately mirror Claude Code's tools").
 * The replace_all path (split/join, both string args) does NOT have this
 * bug -- see the passing contrast test below.
 *
 * Fixed: the single-replace path now uses an indexOf-based literal splice.
 * These tests lock in the literal-insertion contract for both paths.
 */
describe('createTools: edit_file single-replace $-token defect', () => {
  it('should insert new_string literally when it contains a $ token', async () => {
    const dir = tempDir()
    const tools = createTools(dir)
    writeFileSync(join(dir, 'f.txt'), 'before AAA after')

    await (tools.edit_file as any).execute(
      { path: 'f.txt', old_string: 'AAA', new_string: 'cost is $&stuff' }, {} as any)

    expect(readFileSync(join(dir, 'f.txt'), 'utf-8')).toBe('before cost is $&stuff after')
  })

  it('replace_all does not have the $-token bug (contrast case)', async () => {
    const dir = tempDir()
    const tools = createTools(dir)
    writeFileSync(join(dir, 'f.txt'), 'before AAA after')

    await (tools.edit_file as any).execute(
      { path: 'f.txt', old_string: 'AAA', new_string: 'cost is $&stuff', replace_all: true }, {} as any)

    expect(readFileSync(join(dir, 'f.txt'), 'utf-8')).toBe('before cost is $&stuff after')
  })
})

/**
 * Regression lock for the in-band error-part fix: the AI SDK surfaces
 * provider failures as { type: 'error' } parts in fullStream and finishes
 * the stream normally instead of throwing. The runtime must capture those
 * and route them through its error classification (retry/backoff for
 * transient, truthful error text otherwise) rather than returning a silent
 * null. Uses MockLanguageModelV3 — fully offline, no network.
 */
describe('AiSdkAgentRuntime stream error handling', () => {
  it('routes in-band error parts through error classification', async () => {
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')

    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'error' as const, error: new Error('invalid x-api-key header') },
          ],
        }),
      }),
    })

    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const runtime = new AiSdkAgentRuntime(fakeStore(), model as any)
    const result = await runtime.run({ message: 'hello' })

    expect(result.text).toContain("Ran into an error and couldn't finish that")
    expect(result.text).toContain('invalid x-api-key header')
  })
})

/**
 * Regression lock for the prompt-cache wiring (history.ts): breakpoint 2
 * (prepareStep -> withCacheBreakpoint) must mark the outbound request to
 * the model, but the session row saved to SQLite afterwards must stay free
 * of the cacheControl marker -- history.ts clones rather than mutates, and
 * index.ts saves the pre-prepareStep `messages` array, not whatever
 * prepareStep produced for the wire. This exercises the real ToolLoopAgent
 * (the 'ai' module is NOT mocked in this file), so prepareStep genuinely
 * runs -- unlike tests/ai-sdk-subagent.test.ts, which stubs ToolLoopAgent
 * entirely and never gives history.ts's runtime wiring a chance to regress.
 */
describe('AiSdkAgentRuntime cache-breakpoint / session persistence wiring', () => {
  it('marks the outbound request but saves an unmarked session row', async () => {
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')

    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            { type: 'text-delta' as const, id: 't1', delta: 'hi there' },
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: 'stop' as const,
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            },
          ],
        }),
      }),
    })

    const store = fakeStore()
    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const runtime = new AiSdkAgentRuntime(store, model as any)
    const result = await runtime.run({ message: 'hello' })

    expect(result.text).toBe('hi there')

    // Breakpoint 2 fired: the actual request the model received carries the
    // Anthropic cache marker on the last prompt message.
    expect(model.doStreamCalls).toHaveLength(1)
    const sentPrompt = model.doStreamCalls[0].prompt as Array<{ providerOptions?: Record<string, unknown> }>
    const lastSent = sentPrompt[sentPrompt.length - 1]
    expect(lastSent.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })

    // Persisted session row stays unmarked: withCacheBreakpoint clones, and
    // index.ts saves the pre-prepareStep array, not the wire-marked one.
    const saved = store.load(result.newSessionId!)
    expect(saved).not.toBeNull()
    expect(saved!.length).toBeGreaterThan(0)
    for (const msg of saved!) {
      const anthropicOpts = (msg as { providerOptions?: Record<string, unknown> }).providerOptions?.['anthropic'] as
        | Record<string, unknown>
        | undefined
      expect(anthropicOpts?.cacheControl).toBeUndefined()
    }
  })
})

describe('parseMcpConfig', () => {
  it('accepts the flat map shape this repo uses', async () => {
    const { parseMcpConfig } = await import('../src/runtime/ai-sdk/mcp.js')
    const servers = parseMcpConfig('{"playwright": {"command": "bash", "args": ["wrapper.sh"]}}')
    expect(Object.keys(servers)).toEqual(['playwright'])
    expect(servers.playwright.command).toBe('bash')
    expect(servers.playwright.args).toEqual(['wrapper.sh'])
  })

  it("accepts Claude Code's mcpServers wrapper shape", async () => {
    const { parseMcpConfig } = await import('../src/runtime/ai-sdk/mcp.js')
    const servers = parseMcpConfig('{"mcpServers": {"foo": {"command": "npx", "args": ["-y", "foo"]}}}')
    expect(Object.keys(servers)).toEqual(['foo'])
    expect(servers.foo.command).toBe('npx')
  })

  it('skips entries without a command and tolerates empty config', async () => {
    const { parseMcpConfig } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(parseMcpConfig('{"bad": {"url": "http://x"}, "good": {"command": "node"}}')).toHaveProperty('good')
    expect(parseMcpConfig('{"bad": {"url": "http://x"}}')).toEqual({})
    expect(parseMcpConfig('{}')).toEqual({})
  })
})

describe('runtime factory', () => {
  it("registers 'ai-sdk' and lists it in the unknown-runtime error", () => {
    process.env.AGENT_RUNTIME = 'bogus'
    expect(() => getAgentRuntime()).toThrow(/claude, ai-sdk/)
  })

  it("selects the ai-sdk runtime when AGENT_RUNTIME=ai-sdk", () => {
    process.env.AGENT_RUNTIME = 'ai-sdk'
    expect(getAgentRuntime().id).toBe('ai-sdk')
  })
})

describe('runtime factory lane routing', () => {
  afterEach(() => {
    delete process.env.AGENT_RUNTIME_CRON
  })

  it('routes cron to AGENT_RUNTIME_CRON while chat follows AGENT_RUNTIME', () => {
    process.env.AGENT_RUNTIME = 'ai-sdk'
    process.env.AGENT_RUNTIME_CRON = 'claude'
    expect(getAgentRuntime('chat').id).toBe('ai-sdk')
    expect(getAgentRuntime('cron').id).toBe('claude')
  })

  it('cron falls back to AGENT_RUNTIME when AGENT_RUNTIME_CRON is unset', () => {
    process.env.AGENT_RUNTIME = 'ai-sdk'
    expect(getAgentRuntime('cron').id).toBe('ai-sdk')
  })

  it('caches one instance per runtime id, shared across lanes', () => {
    process.env.AGENT_RUNTIME = 'claude'
    process.env.AGENT_RUNTIME_CRON = 'claude'
    expect(getAgentRuntime('chat')).toBe(getAgentRuntime('cron'))

    process.env.AGENT_RUNTIME_CRON = 'ai-sdk'
    expect(getAgentRuntime('cron')).not.toBe(getAgentRuntime('chat'))
    expect(getAgentRuntime('cron')).toBe(getAgentRuntime('cron'))
  })

  it('setAgentRuntime override wins for every lane', () => {
    const fake = { id: 'fake' } as any
    setAgentRuntime(fake)
    process.env.AGENT_RUNTIME_CRON = 'claude'
    expect(getAgentRuntime('chat')).toBe(fake)
    expect(getAgentRuntime('cron')).toBe(fake)
  })

  it('re-reads env on each call (runtime switch without restart)', () => {
    process.env.AGENT_RUNTIME = 'claude'
    expect(getAgentRuntime().id).toBe('claude')
    process.env.AGENT_RUNTIME = 'ai-sdk'
    expect(getAgentRuntime().id).toBe('ai-sdk')
  })
})
