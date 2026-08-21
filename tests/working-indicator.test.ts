import { describe, it, expect, beforeEach } from 'vitest'
import { workingPhrase, resetWorkingPhrases } from '../src/working-indicator.js'

beforeEach(() => resetWorkingPhrases())

describe('workingPhrase', () => {
  it('turns the raw shell tool name into words (the card #97 complaint)', () => {
    expect(workingPhrase('bash')).toBe('Running a command')
  })

  it('maps every runtime spelling of a tool to the same category', () => {
    // agent-sdk capitalizes, ai-sdk is lowercase with underscores
    expect(workingPhrase('Bash')).toBe('Running a command')
    expect(workingPhrase('WebSearch')).toBe('Searching the web')
    expect(workingPhrase('web_search')).toBe('Looking that up online') // same pool, rotated once
    expect(workingPhrase('web-search')).toBe('Searching the web')
  })

  it('rotates through a category pool and wraps around', () => {
    expect(workingPhrase('bash')).toBe('Running a command')
    expect(workingPhrase('bash')).toBe('Working in the terminal')
    expect(workingPhrase('bash')).toBe('Running a command')
  })

  it('rotates categories independently', () => {
    workingPhrase('bash')
    expect(workingPhrase('read')).toBe('Reading files')
  })

  it('covers the common file tools', () => {
    expect(workingPhrase('Read')).toBe('Reading files')
    expect(workingPhrase('Edit')).toBe('Updating files')
    expect(workingPhrase('Write')).toBe('Making edits') // same pool as Edit, rotated
    expect(workingPhrase('Grep')).toBe('Searching the project')
    expect(workingPhrase('Glob')).toBe('Digging through files')
    expect(workingPhrase('WebFetch')).toBe('Reading a web page')
    expect(workingPhrase('TodoWrite')).toBe('Planning the steps')
    expect(workingPhrase('Task')).toBe('Handing this to a helper')
  })

  it('recognizes browser automation whichever MCP server provides it', () => {
    expect(workingPhrase('mcp__playwright__browser_navigate')).toBe('Browsing the web')
    expect(workingPhrase('mcp__plugin_playwright_playwright__browser_click')).toBe('Working in the browser')
  })

  it('names the server for other MCP tools, tidied for humans', () => {
    expect(workingPhrase('mcp__kanban-zone__create_card')).toBe('Working in kanban zone')
    expect(workingPhrase('mcp__kanban-zone__move_card')).toBe('Still in kanban zone')
  })

  it('keeps single underscores inside an MCP server name intact', () => {
    expect(workingPhrase('mcp__claude_ai_Notion__notion-search')).toBe('Working in claude ai Notion')
  })

  it('falls back to a friendly generic for unknown tools, with variety', () => {
    const first = workingPhrase('SomeNewTool')
    const second = workingPhrase('SomeNewTool')
    expect(first).toBe('Working on it')
    expect(second).toBe('On it')
    expect(first).not.toBe(second)
  })

  it('never leaks a raw tool name to the chat, whatever shape arrives', () => {
    const raw = ['bash', 'web_search', 'mcp__gmail__send', 'weird_tool_v2', 'Bash']
    for (const name of raw) {
      const phrase = workingPhrase(name)
      expect(phrase).not.toBe(name)
      expect(phrase).not.toMatch(/__|mcp/)
      // Reads as words: starts with a capital, contains no underscores.
      expect(phrase).toMatch(/^[A-Z]/)
      expect(phrase).not.toContain('_')
    }
  })
})
