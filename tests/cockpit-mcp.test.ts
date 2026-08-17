/**
 * tests/cockpit-mcp.test.ts
 * Coverage for src/cockpit/mcp.ts -- the cockpit's declared-MCP-servers panel.
 *
 * The panel reads the same .mcp.json the ai-sdk runtime loads, so it has to
 * accept both shapes the file comes in (nested { mcpServers: {...} } and flat
 * { name: {...} }). It once read only the nested key, which made a flat file
 * look completely empty in the UI while the runtime happily ran every server
 * in it. Both shapes are pinned here.
 *
 * Sources are injected as temp files via collectDeclaredServers() -- no
 * reading of the developer's real ~/.mcp.json.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectDeclaredServers,
  getDeclaredMcpServers,
  type McpConfigSource,
} from '../src/cockpit/mcp.js'
import { isNestedMcpShape, selectMcpServerMap } from '../src/mcp-shape.js'
import { parseMcpConfig } from '../src/runtime/ai-sdk/mcp.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Write `content` to a temp file and return it as a single labelled source. */
function source(content: unknown, label = 'project/.mcp.json'): McpConfigSource {
  const path = join(tempDir(), '.mcp.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return { path, label }
}

describe('collectDeclaredServers: config shapes', () => {
  it("reads Claude Code's nested mcpServers shape", () => {
    const servers = collectDeclaredServers([
      source({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] } } }),
    ])
    expect(servers).toEqual([
      { name: 'playwright', source: 'project/.mcp.json', transport: 'stdio' },
    ])
  })

  it('reads the flat shape, where the file itself is the server map', () => {
    const servers = collectDeclaredServers([
      source({ playwright: { command: 'bash', args: ['wrapper.sh'] } }),
    ])
    expect(servers).toEqual([
      { name: 'playwright', source: 'project/.mcp.json', transport: 'stdio' },
    ])
  })

  it('lists every server in a flat file, not just the first', () => {
    const servers = collectDeclaredServers([
      source({
        playwright: { command: 'npx' },
        notion: { url: 'https://mcp.notion.com/mcp' },
        remote: { type: 'sse', url: 'https://example.test/sse' },
      }),
    ])
    expect(servers.map((s) => s.name)).toEqual(['notion', 'playwright', 'remote'])
    expect(servers.map((s) => s.transport)).toEqual(['http', 'stdio', 'http'])
  })

  it('agrees with the runtime parser on which servers a flat file declares', () => {
    const config = { playwright: { command: 'npx' }, other: { command: 'node' } }
    const declared = collectDeclaredServers([source(config)]).map((s) => s.name)
    expect(declared).toEqual(Object.keys(parseMcpConfig(JSON.stringify(config))).sort())
  })
})

describe('collectDeclaredServers: transports', () => {
  it('labels command entries stdio and url entries http, and passes type through', () => {
    const servers = collectDeclaredServers([
      source({
        mcpServers: {
          stdio: { command: 'node', args: ['server.js'] },
          hosted: { url: 'https://example.test/mcp' },
          typed: { type: 'sse' },
        },
      }),
    ])
    expect(Object.fromEntries(servers.map((s) => [s.name, s.transport]))).toEqual({
      stdio: 'stdio',
      hosted: 'http',
      typed: 'sse',
    })
  })

  it('keeps a nested entry whose transport cannot be determined', () => {
    const servers = collectDeclaredServers([source({ mcpServers: { mystery: {} } })])
    expect(servers).toEqual([
      { name: 'mystery', source: 'project/.mcp.json', transport: undefined },
    ])
  })
})

describe('collectDeclaredServers: non-MCP config files', () => {
  // ~/.claude.json and settings.json are in the real source list, so the flat
  // fallback must not turn their top-level keys into servers.
  it('ignores unrelated top-level keys when falling back to the flat shape', () => {
    const servers = collectDeclaredServers([
      source(
        {
          model: 'opus',
          includeCoAuthoredBy: true,
          env: { SOME_VAR: 'value' },
          permissions: { allow: ['Bash(npm run test)'] },
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        },
        'user/settings.json'
      ),
    ])
    expect(servers).toEqual([])
  })

  it('still finds an mcpServers block inside a larger settings file', () => {
    const servers = collectDeclaredServers([
      source(
        { model: 'opus', mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } },
        'user/settings.json'
      ),
    ])
    expect(servers).toEqual([
      { name: 'notion', source: 'user/settings.json', transport: 'http' },
    ])
  })
})

describe('collectDeclaredServers: precedence and bad input', () => {
  it('lets the first source win a name collision', () => {
    const servers = collectDeclaredServers([
      source({ mcpServers: { dup: { command: 'from-home' } } }, '~/.mcp.json'),
      source({ dup: { command: 'from-project' } }, 'project/.mcp.json'),
    ])
    expect(servers).toEqual([{ name: 'dup', source: '~/.mcp.json', transport: 'stdio' }])
  })

  it('skips a junk flat entry rather than letting it claim the name', () => {
    const servers = collectDeclaredServers([
      source({ dup: 'not-a-server' }, '~/.mcp.json'),
      source({ dup: { command: 'real' } }, 'project/.mcp.json'),
    ])
    expect(servers).toEqual([{ name: 'dup', source: 'project/.mcp.json', transport: 'stdio' }])
  })

  it('skips missing files, malformed JSON, and non-object contents', () => {
    const missing: McpConfigSource = { path: join(tempDir(), 'nope.json'), label: '~/.mcp.json' }
    expect(
      collectDeclaredServers([
        missing,
        source('{not valid json', '~/.claude.json'),
        source('[]', 'project/.mcp.json'),
        source({ mcpServers: null }, 'user/settings.json'),
      ])
    ).toEqual([])
  })

  it('returns nothing for an empty source list', () => {
    expect(collectDeclaredServers([])).toEqual([])
  })
})

describe('getDeclaredMcpServers', () => {
  it('reads the real source list without throwing', () => {
    // Whatever this machine has configured, the call must be safe and sorted.
    const servers = getDeclaredMcpServers()
    expect(Array.isArray(servers)).toBe(true)
    expect(servers.map((s) => s.name)).toEqual([...servers.map((s) => s.name)].sort())
  })
})

describe('selectMcpServerMap', () => {
  it('unwraps the nested shape and passes the flat shape through', () => {
    expect(selectMcpServerMap({ mcpServers: { a: { command: 'x' } } })).toEqual({ a: { command: 'x' } })
    expect(selectMcpServerMap({ a: { command: 'x' } })).toEqual({ a: { command: 'x' } })
  })

  it('returns null when there is no usable map', () => {
    expect(selectMcpServerMap(null)).toBeNull()
    expect(selectMcpServerMap('string')).toBeNull()
    expect(selectMcpServerMap({ mcpServers: null })).toBeNull()
    expect(selectMcpServerMap({ mcpServers: 'nope' })).toBeNull()
  })

  it('reports which shape the data used', () => {
    expect(isNestedMcpShape({ mcpServers: {} })).toBe(true)
    expect(isNestedMcpShape({ a: { command: 'x' } })).toBe(false)
    expect(isNestedMcpShape(null)).toBe(false)
  })
})

describe('hand-written flat config', () => {
  // The realistic regression case: an owner's pre-existing flat .mcp.json at a
  // project root, byte-for-byte as they would have typed it. This is the file
  // that used to render an empty panel.
  it('surfaces a flat project config written by hand', () => {
    const path = join(tempDir(), '.mcp.json')
    writeFileSync(
      path,
      `{
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest", "--headless"]
  }
}
`
    )
    expect(collectDeclaredServers([{ path, label: 'project/.mcp.json' }])).toEqual([
      { name: 'playwright', source: 'project/.mcp.json', transport: 'stdio' },
    ])
  })
})
