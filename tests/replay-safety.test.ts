import { describe, it, expect } from 'vitest'
import { isReplaySafeTool, unsafeToolNames, noRetryNotice } from '../src/runtime/replay-safety.js'

describe('isReplaySafeTool', () => {
  it.each(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'])('%s is safe to replay', (name) => {
    expect(isReplaySafeTool(name)).toBe(true)
  })

  it.each([
    'mcp__notion-personal__API-retrieve-a-page',
    'mcp__notion-personal__API-query-data-source',
    'mcp__notion-personal__API-post-search',
    'mcp__excalidraw-plus__list_scenes',
    'mcp__excalidraw-plus__get_scene',
    'mcp__x__read',
  ])('read-style MCP tool %s is safe', (name) => {
    expect(isReplaySafeTool(name)).toBe(true)
  })

  it.each([
    'Bash',
    'Write',
    'Edit',
    'Agent',
    'NotebookEdit',
    'mcp__notion-personal__API-post-page',
    'mcp__notion-personal__API-patch-page',
    'mcp__notion-personal__API-create-a-comment',
    'mcp__excalidraw-plus__delete_scene',
    'mcp__playwright__browser_click',
    'SomethingNew',
    'mcp__x__get_and_delete_scene',
    'mcp__x__list_then_send',
    'mcp__x__query_database',
    'mcp__notion-personal__API-get-and-patch-page',
  ])('%s is not safe: a replay could repeat its effect', (name) => {
    expect(isReplaySafeTool(name)).toBe(false)
  })
})

describe('unsafeToolNames', () => {
  it('lists each unsafe tool once and skips the safe ones', () => {
    expect(unsafeToolNames(['Read', 'Bash', 'Grep', 'Bash', 'Write'])).toEqual(['Bash', 'Write'])
    expect(unsafeToolNames([])).toEqual([])
  })
})

describe('noRetryNotice', () => {
  it('names the tools and avoids the words the scheduler uses to defer and re-run a task', () => {
    const text = noRetryNotice(['Bash', 'Write'])
    expect(text).toContain('Bash, Write')
    expect(text).not.toMatch(/\b(429|529|rate.?limit|overloaded)\b/i)
    expect(text).not.toMatch(/API is temporarily overloaded/i)
  })

  it('shortens a long list', () => {
    expect(noRetryNotice(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain('a, b, c, d, e, ...')
  })
})
