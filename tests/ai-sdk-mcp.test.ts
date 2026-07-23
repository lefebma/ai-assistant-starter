/**
 * tests/ai-sdk-mcp.test.ts
 * Offline coverage for src/runtime/ai-sdk/mcp.ts (Phase 2, second slice).
 *
 * Never spawns a real MCP server process. `createMCPClient` and the stdio
 * transport are mocked at the module boundary, so loadMcpTools() runs for
 * real but every actual connection attempt is fake. Timing-sensitive
 * behavior (the 10s connect timeout) uses vitest fake timers instead of
 * a real wall-clock wait.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}))
vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: vi.fn().mockImplementation((cfg: { command: string }) => ({
    __command: cfg.command,
  })),
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  delete process.env.AI_MCP
  vi.clearAllMocks()
  vi.useRealTimers()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-mcp-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('loadMcpTools: kill switch and absent config', () => {
  it('skips reading .mcp.json entirely when AI_MCP=off', async () => {
    const root = tempDir()
    // A real-looking config present on disk -- must never be read, let alone connected to.
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ playwright: { command: 'bash', args: ['x.sh'] } }))
    process.env.AI_MCP = 'off'

    const { createMCPClient } = await import('@ai-sdk/mcp')
    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(await loadMcpTools(root)).toEqual({})
    expect(createMCPClient).not.toHaveBeenCalled()
  })

  it('returns no tools without error when .mcp.json does not exist', async () => {
    const root = tempDir() // empty, no .mcp.json
    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(await loadMcpTools(root)).toEqual({})
  })

  it('returns no tools without error when .mcp.json is malformed JSON', async () => {
    const root = tempDir()
    writeFileSync(join(root, '.mcp.json'), '{not valid json')
    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(await loadMcpTools(root)).toEqual({})
  })
})

describe('loadMcpTools: per-server graceful degradation', () => {
  it('namespaces tools as mcp__<server>__<tool> and skips a server that fails to connect', async () => {
    const { createMCPClient } = await import('@ai-sdk/mcp')
    ;(createMCPClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ transport }: { transport: { __command: string } }) => {
        if (transport.__command === 'bad-cmd') throw new Error('ECONNREFUSED (simulated)')
        return { tools: async () => ({ ping: { execute: async () => 'pong' } }) }
      }
    )

    const root = tempDir()
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ good: { command: 'good-cmd' }, bad: { command: 'bad-cmd' } })
    )

    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    const tools = await loadMcpTools(root)

    expect(Object.keys(tools)).toEqual(['mcp__good__ping'])
  })

  it("skips a server whose client connects but whose tools() call fails", async () => {
    const { createMCPClient } = await import('@ai-sdk/mcp')
    ;(createMCPClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      tools: async () => {
        throw new Error('tools() boom')
      },
    })

    const root = tempDir()
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ flaky: { command: 'flaky-cmd' } }))

    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(await loadMcpTools(root)).toEqual({})
  })

  it('accepts the mcpServers wrapper shape end-to-end (not just via parseMcpConfig)', async () => {
    const { createMCPClient } = await import('@ai-sdk/mcp')
    ;(createMCPClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      tools: async () => ({ run: { execute: async () => 'ok' } }),
    })

    const root = tempDir()
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { foo: { command: 'foo-cmd' } } }))

    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    expect(await loadMcpTools(root)).toEqual({ mcp__foo__run: { execute: expect.any(Function) } })
  })
})

describe('loadMcpTools: connect timeout', () => {
  it('does not hang forever when a server connect never resolves', async () => {
    vi.useFakeTimers()
    const { createMCPClient } = await import('@ai-sdk/mcp')
    // Never resolves or rejects -- simulates a server hung mid-handshake.
    ;(createMCPClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))

    const root = tempDir()
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ hung: { command: 'hung-cmd' } }))

    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    const pending = loadMcpTools(root)

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({})
  })
})
