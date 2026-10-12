/**
 * Card #196, part 1: every tool call, through the one checkpoint both runtimes
 * share (gateToolCall), lands in the audit log with its actor and outcome, and
 * nothing the assistant runs can change the log. Config is mocked so the log
 * is on, in a temp dir, for this file only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'havn-audit-trail-'))
const AUDIT = join(ROOT, 'audit')
const STORE = join(ROOT, 'store')

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return { ...actual, AUDIT_DIR: AUDIT, STORE_DIR: STORE, TOOL_GUARD: 'log' }
})

const { gateToolCall } = await import('../src/assurance/scope-gate.js')
const { withActor, describeToolCall, resolveAuditDir, resetAuditTrail, getAuditTrail } = await import('../src/assurance/audit-trail.js')
const { AuditLog } = await import('../src/assurance/audit-log.js')

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(AUDIT, { recursive: true, force: true })
  resetAuditTrail()
})

const records = () =>
  readFileSync(join(AUDIT, 'audit.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const call = (tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
  gateToolCall({ session: 'sess-1', tool, input, cwd: ROOT, ...extra })

describe('describeToolCall', () => {
  it('keeps the command or path and drops payloads', () => {
    expect(describeToolCall('Bash', { command: 'ls -la' })).toBe('Bash ls -la')
    expect(describeToolCall('Write', { file_path: '/home/havn/notes.md', content: 'private letter' })).toBe('Write /home/havn/notes.md')
    expect(describeToolCall('Grep', { pattern: 'invoice', path: 'docs' })).toBe('Grep docs invoice')
    expect(describeToolCall('WebFetch', { url: 'https://example.com/a', prompt: 'summarise' })).toBe('WebFetch https://example.com/a')
  })

  it('records only argument names for MCP and other tools', () => {
    const d = describeToolCall('mcp__gmail__send', { to: 'client@example.com', subject: 'Re: case', body: 'confidential' })
    expect(d).toBe('mcp__gmail__send {to, subject, body}')
  })

  it('redacts secrets and caps the length', () => {
    expect(describeToolCall('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" x' })).not.toContain('abcdefghijklmnop')
    expect(describeToolCall('Bash', { command: 'echo ' + 'x'.repeat(2000) }).length).toBe(500)
  })
})

describe('resolveAuditDir', () => {
  it('prefers a root-made hosted store over anything configured', () => {
    const hosted = join(ROOT, 'hosted')
    mkdirSync(hosted, { recursive: true })
    expect(resolveAuditDir('/somewhere/else', hosted)).toBe('/somewhere/else')
    writeFileSync(join(hosted, 'audit.jsonl'), '')
    expect(resolveAuditDir('/somewhere/else', hosted)).toBe(hosted)
    expect(resolveAuditDir('', join(ROOT, 'missing'))).toBeNull()
  })
})

describe('gateToolCall records every tool call (card #196)', () => {
  it('records allowed calls with actor, run and tool, chained', () => {
    withActor('chat:42', () => {
      expect(call('Read', { file_path: '/etc/hostname' }).allow).toBe(true)
      expect(call('mcp__calendar__list', { day: 'today' }).allow).toBe(true)
    })
    call('Bash', { command: 'date' })
    const r = records()
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ seq: 1, actor: 'chat:42', runId: 'sess-1', action: 'Read', outcome: 'allowed', detail: 'Read /etc/hostname' })
    expect(r[1]).toMatchObject({ seq: 2, actor: 'chat:42', action: 'mcp__calendar__list', detail: 'mcp__calendar__list {day}' })
    expect(r[2]).toMatchObject({ seq: 3, actor: 'unattributed' })
    expect(r[1].prevHash).toBe(r[0].hash)
    expect(new AuditLog({ dir: AUDIT, workspace: ROOT + '-ws' }).verify().ok).toBe(true)
  })

  it('keeps the actor across awaits inside the run', async () => {
    await withActor('job:abc', async () => {
      await new Promise((r) => setTimeout(r, 5))
      call('Bash', { command: 'uptime' })
    })
    expect(records()[0].actor).toBe('job:abc')
  })

  it('records a tool guard hit in log mode as allowed, with the rule', () => {
    expect(call('Bash', { command: 'cat ~/.ssh/id_rsa' }).allow).toBe(true)
    const [r] = records()
    expect(r.outcome).toBe('allowed')
    expect(r.detail).toMatch(/:: tool guard would block: /)
  })

  it('records a role refusal as denied', () => {
    const v = call('Write', { file_path: join(ROOT, 'x.txt'), content: 'hi' }, { scope: { role: 'briefing', taskId: 't1' } })
    expect(v.allow).toBe(false)
    const [r] = records()
    expect(r.outcome).toBe('denied')
    expect(r.detail).toMatch(/:: role briefing: /)
  })

  it('refuses writes into the audit store and records the attempt', () => {
    const w = call('Write', { file_path: join(AUDIT, 'audit.jsonl'), content: '' })
    const b = call('Bash', { command: `truncate -s0 ${AUDIT}/audit.jsonl` })
    const e = call('Edit', { file_path: join(AUDIT, '..', 'audit', 'audit.jsonl'), old_string: 'a', new_string: 'b' })
    expect([w.allow, b.allow, e.allow]).toEqual([false, false, false])
    expect(call('Read', { file_path: join(AUDIT, 'audit.jsonl') }).allow).toBe(true)
    const r = records()
    expect(r.map((x) => x.outcome)).toEqual(['blocked', 'blocked', 'blocked', 'allowed'])
  })

  it('fails open when the store cannot be opened', () => {
    writeFileSync(AUDIT, 'not a directory')
    expect(call('Bash', { command: 'ls' }).allow).toBe(true)
    expect(getAuditTrail(AUDIT, ROOT + '-ws')).toBeNull()
    rmSync(AUDIT)
  })
})
