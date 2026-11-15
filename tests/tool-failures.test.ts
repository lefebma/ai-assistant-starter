import { describe, it, expect } from 'vitest'
import { failedToolNames, toolFailureNotice } from '../src/runtime/tool-failures.js'

describe('failedToolNames', () => {
  it('maps ids to names, keeps order, drops repeats', () => {
    const calls = new Map([['a', 'Bash'], ['b', 'mcp__x__send'], ['c', 'Bash']])
    expect(failedToolNames(calls, ['a', 'b', 'c'])).toEqual(['Bash', 'mcp__x__send'])
  })

  it('falls back to a generic name for an id it never saw', () => {
    expect(failedToolNames(new Map(), ['zzz'])).toEqual(['a tool'])
  })

  it('is empty when nothing errored', () => {
    expect(failedToolNames(new Map([['a', 'Bash']]), [])).toEqual([])
  })
})

describe('toolFailureNotice', () => {
  it('names the failed tool when the turn ended blank', () => {
    const note = toolFailureNotice('', ['Bash'])
    expect(note).toContain('Bash')
    expect(note).toMatch(/not done/)
  })

  it('treats null, undefined and whitespace as blank', () => {
    for (const blank of [null, undefined, '   \n']) expect(toolFailureNotice(blank, ['Bash'])).not.toBeNull()
  })

  it('stays out of the way when the model wrote anything', () => {
    expect(toolFailureNotice('The calendar call failed, so I did not create the event.', ['gog'])).toBeNull()
    expect(toolFailureNotice('Done.', ['Bash'])).toBeNull()
  })

  it('says nothing when no tool failed', () => {
    expect(toolFailureNotice('', [])).toBeNull()
    expect(toolFailureNotice(null, [])).toBeNull()
  })

  it('pluralises and truncates a long list', () => {
    const note = toolFailureNotice('', ['A', 'B', 'C', 'D', 'E', 'F'])!
    expect(note).toContain('tool calls failed')
    expect(note).toContain('A, B, C, D, ...')
    expect(note).not.toContain('E')
  })

  it('does not contain the words the scheduler keys off to defer and re-run a task', () => {
    const note = toolFailureNotice('', ['Bash'])!
    expect(note).not.toMatch(/overloaded|rate.?limit|\b429\b|\b529\b|HEARTBEAT_OK|NO_REPLY/i)
  })
})
