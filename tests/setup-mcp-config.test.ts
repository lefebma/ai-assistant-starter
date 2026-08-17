import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ensurePlaywrightMcp,
  mergePlaywrightServer,
  playwrightServerEntry,
  PLAYWRIGHT_SERVER_NAME,
} from '../src/setup/mcp-config.js'
import { parseMcpConfig } from '../src/runtime/ai-sdk/mcp.js'

const ENTRY = playwrightServerEntry('/opt/havn', '/opt/havn/runtime/bin/node')

describe('playwrightServerEntry', () => {
  it('writes absolute paths for both the interpreter and the launcher', () => {
    // Bundle installs may have no `node` on PATH, and neither runtime pins a
    // cwd for the MCP child, so nothing here may be relative.
    expect(ENTRY.command).toBe('/opt/havn/runtime/bin/node')
    expect(ENTRY.args).toEqual([resolve('/opt/havn', 'dist', 'scripts', 'playwright-mcp.js')])
  })
})

describe('mergePlaywrightServer', () => {
  it('creates a nested-shape file when .mcp.json is absent', () => {
    const { content, outcome } = mergePlaywrightServer(null, ENTRY)
    expect(outcome).toBe('created')
    expect(JSON.parse(content!)).toEqual({ mcpServers: { playwright: ENTRY } })
  })

  it('treats an empty file the same as a missing one', () => {
    expect(mergePlaywrightServer('   \n', ENTRY).outcome).toBe('created')
  })

  it('adds to a nested-shape file without disturbing the other servers', () => {
    const existing = JSON.stringify({
      mcpServers: { gmail: { command: 'gog', args: ['mcp'] } },
      otherTopLevelKey: true,
    })
    const { content, outcome } = mergePlaywrightServer(existing, ENTRY)
    expect(outcome).toBe('added')
    const parsed = JSON.parse(content!)
    expect(parsed.mcpServers.gmail).toEqual({ command: 'gog', args: ['mcp'] })
    expect(parsed.mcpServers.playwright).toEqual(ENTRY)
    expect(parsed.otherTopLevelKey).toBe(true)
  })

  it('adds to a flat-shape file and keeps it flat', () => {
    const existing = JSON.stringify({ gmail: { command: 'gog', args: ['mcp'] } })
    const { content, outcome } = mergePlaywrightServer(existing, ENTRY)
    expect(outcome).toBe('added')
    const parsed = JSON.parse(content!)
    expect(parsed.mcpServers).toBeUndefined()
    expect(parsed.playwright).toEqual(ENTRY)
    expect(parsed.gmail).toEqual({ command: 'gog', args: ['mcp'] })
  })

  it('is a no-op when the entry already exists, in either shape', () => {
    const nested = JSON.stringify({ mcpServers: { playwright: { command: 'custom', args: [] } } })
    expect(mergePlaywrightServer(nested, ENTRY)).toEqual({ content: null, outcome: 'present' })

    const flat = JSON.stringify({ playwright: { command: 'custom', args: [] } })
    expect(mergePlaywrightServer(flat, ENTRY)).toEqual({ content: null, outcome: 'present' })
  })

  it('never overwrites an owner-customised entry', () => {
    // Re-running setup must not stomp a hand-edited command.
    const custom = { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] }
    const result = mergePlaywrightServer(JSON.stringify({ mcpServers: { playwright: custom } }), ENTRY)
    expect(result.content).toBeNull()
  })

  it('leaves an unparsable file alone rather than replacing it', () => {
    // The file may hold the owner's only copy of other server credentials.
    expect(mergePlaywrightServer('{ not json', ENTRY)).toEqual({ content: null, outcome: 'unparsable' })
  })

  it('rejects non-object JSON instead of writing into it', () => {
    expect(mergePlaywrightServer('[]', ENTRY).outcome).toBe('unparsable')
    expect(mergePlaywrightServer('null', ENTRY).outcome).toBe('unparsable')
    expect(mergePlaywrightServer('"a string"', ENTRY).outcome).toBe('unparsable')
  })

  it('produces output the runtime parser actually accepts', () => {
    // The whole point of the entry is that loadMcpTools can read it back.
    for (const seed of [null, JSON.stringify({ gmail: { command: 'gog' } })]) {
      const { content } = mergePlaywrightServer(seed, ENTRY)
      const servers = parseMcpConfig(content!)
      expect(servers[PLAYWRIGHT_SERVER_NAME]).toEqual(ENTRY)
    }
  })

  it('ends the file with a newline', () => {
    expect(mergePlaywrightServer(null, ENTRY).content!.endsWith('}\n')).toBe(true)
  })
})

describe('ensurePlaywrightMcp', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'mcp-ensure-'))
  const read = (r: string) => JSON.parse(readFileSync(join(r, '.mcp.json'), 'utf-8'))

  it('creates .mcp.json at the install root when absent', () => {
    const r = root()
    const { outcome } = ensurePlaywrightMcp(r, '/usr/bin/node')
    expect(outcome).toBe('created')
    expect(read(r).mcpServers.playwright).toEqual({
      command: '/usr/bin/node',
      args: [resolve(r, 'dist', 'scripts', 'playwright-mcp.js')],
    })
  })

  it('is idempotent, so running it on every update changes nothing', () => {
    // This is what makes the updater call safe to run unconditionally.
    const r = root()
    ensurePlaywrightMcp(r, '/usr/bin/node')
    const first = readFileSync(join(r, '.mcp.json'), 'utf-8')
    expect(ensurePlaywrightMcp(r, '/usr/bin/node').outcome).toBe('present')
    expect(readFileSync(join(r, '.mcp.json'), 'utf-8')).toBe(first)
  })

  it('preserves other servers an owner already configured', () => {
    const r = root()
    writeFileSync(join(r, '.mcp.json'), JSON.stringify({ mcpServers: { gmail: { command: 'gog' } } }))
    expect(ensurePlaywrightMcp(r, '/usr/bin/node').outcome).toBe('added')
    const parsed = read(r)
    expect(parsed.mcpServers.gmail).toEqual({ command: 'gog' })
    expect(parsed.mcpServers.playwright).toBeDefined()
  })

  it('leaves a hand-edited playwright entry alone', () => {
    // An update must never stomp a customised command.
    const r = root()
    const custom = { mcpServers: { playwright: { command: 'npx', args: ['--headless'] } } }
    writeFileSync(join(r, '.mcp.json'), JSON.stringify(custom))
    expect(ensurePlaywrightMcp(r, '/usr/bin/node').outcome).toBe('present')
    expect(read(r)).toEqual(custom)
  })

  it('does not destroy an unparsable file', () => {
    const r = root()
    writeFileSync(join(r, '.mcp.json'), '{ broken')
    expect(ensurePlaywrightMcp(r, '/usr/bin/node').outcome).toBe('unparsable')
    expect(readFileSync(join(r, '.mcp.json'), 'utf-8')).toBe('{ broken')
  })
})
