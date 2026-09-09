/**
 * Guards on the wiring, not the logic. Both properties below are invisible in
 * a unit test of the module that owns them, and both fail silently: the first
 * shows up a month later as an audit that quotes the previous audit, the
 * second as a scheduled report full of confident fiction.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AUDIT_PROMPT_TOKEN } from '../src/audit/schedule.js'

const root = resolve(__dirname, '..')
const BOT = readFileSync(resolve(root, 'src/bot.ts'), 'utf-8')
const SCHEDULER = readFileSync(resolve(root, 'src/scheduler.ts'), 'utf-8')

/**
 * Body of a named function declaration, by brace matching from the return type
 * rather than from the first brace after the name: a parameter with an inline
 * object type ({ skipMemory?: boolean }) opens a brace inside the signature.
 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  expect(start, `${declaration} not found`).toBeGreaterThan(-1)
  const ret = source.indexOf('): Promise<void> {', start)
  expect(ret, `${declaration} return type not found`).toBeGreaterThan(-1)
  const open = source.indexOf('{', ret)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces after ${declaration}`)
}

/** A call with balanced parens, so a nested call does not truncate it. */
function callExpression(body: string, callee: string): string {
  const start = body.indexOf(`${callee}(`)
  expect(start, `${callee}( not found`).toBeGreaterThan(-1)
  const open = body.indexOf('(', start)
  let depth = 0
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')' && --depth === 0) return body.slice(start, i + 1)
  }
  throw new Error(`unbalanced parens in ${callee} call`)
}

describe('the audit stays out of the record it audits', () => {
  it('runs its prompt through handleMessage with skipMemory', () => {
    const body = functionBody(BOT, 'async function handleAuditCommand')
    expect(callExpression(body, 'handleMessage')).toContain('skipMemory: true')
  })

  it('handleMessage actually honours the flag', () => {
    const body = functionBody(BOT, 'async function handleMessage')
    expect(body).toContain('if (!opts.skipMemory) await saveConversationTurn')
  })

  it('proves the guard can fail: the extractor sees a call without the flag', () => {
    // Sanity on the extractor. If this ever passes vacuously, the test above is
    // checking nothing.
    const fake = 'x { await handleMessage(adapter, chatId, wrap(text), false) }'
    expect(callExpression(fake, 'handleMessage')).toBe('handleMessage(adapter, chatId, wrap(text), false)')
    expect(callExpression(fake, 'handleMessage')).not.toContain('skipMemory')
  })
})

describe('the scheduled audit gets fresh facts', () => {
  it('expands the digest token before running a task', () => {
    const body = functionBody(SCHEDULER, 'export async function runDueTasks')
    expect(body).toContain('expandTaskPrompt(task.prompt')
    expect(body).toContain('buildAuditPrompt')
  })

  it('runs the expanded prompt, not the stored one', () => {
    const body = functionBody(SCHEDULER, 'export async function runDueTasks')
    const runs = [...body.matchAll(/runAgent\(([A-Za-z.]+)/g)].map((m) => m[1])
    expect(runs.length).toBeGreaterThanOrEqual(2)
    expect(runs).not.toContain('task.prompt')
    for (const arg of runs) expect(arg).toBe('prompt')
  })

  it('the token the scheduler expands is the one the stored prompt carries', () => {
    expect(SCHEDULER.includes('expandTaskPrompt')).toBe(true)
    expect(AUDIT_PROMPT_TOKEN).toBe('{{AUDIT_DIGEST}}')
  })
})
