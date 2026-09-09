import { describe, it, expect } from 'vitest'
import {
  AUDIT_TASK_NAME,
  AUDIT_SCHEDULE,
  AUDIT_PROMPT_TOKEN,
  AUDIT_TASK_PROMPT,
  AUDIT_SEEDED_KEY,
  auditWanted,
  expandTaskPrompt,
  ensureAuditTask,
  setAuditSchedule,
  findAuditTask,
  type AuditScheduleDeps,
  type StoredTask,
} from '../src/audit/schedule.js'

function deps(overrides: Partial<AuditScheduleDeps> = {}): AuditScheduleDeps & { tasks: StoredTask[]; state: Map<string, string> } {
  const tasks: StoredTask[] = []
  const state = new Map<string, string>()
  return {
    tasks,
    state,
    getState: (k) => state.get(k) ?? null,
    setState: (k, v) => void state.set(k, v),
    listTasks: () => tasks,
    createTask: (t) => void tasks.push(t),
    deleteTask: (id) => {
      const i = tasks.findIndex((t) => t.id === id)
      if (i === -1) return false
      tasks.splice(i, 1)
      return true
    },
    newId: () => 'aud12345',
    nextRun: () => 1_760_000_000,
    timeZone: () => 'America/Toronto',
    ...overrides,
  }
}

describe('auditWanted', () => {
  it('is off unless the owner turned it on', () => {
    expect(auditWanted({})).toBe(false)
    expect(auditWanted({ MONTHLY_AUDIT: '' })).toBe(false)
    expect(auditWanted({ MONTHLY_AUDIT: 'off' })).toBe(false)
    expect(auditWanted({ MONTHLY_AUDIT: 'false' })).toBe(false)
    expect(auditWanted({ MONTHLY_AUDIT: 'no' })).toBe(false)
  })

  it('accepts the shapes a person actually writes in a .env', () => {
    for (const v of ['on', 'true', 'yes', '1', 'ON', ' true ']) {
      expect(auditWanted({ MONTHLY_AUDIT: v })).toBe(true)
    }
  })
})

describe('the stored prompt', () => {
  it('carries the token rather than the wording, so a release can improve it', () => {
    expect(AUDIT_TASK_PROMPT).toContain(AUDIT_PROMPT_TOKEN)
    // A task prompt is frozen in SQLite at creation. Anything spelled out here
    // is stuck on that box forever; anything behind the token is not.
    expect(AUDIT_TASK_PROMPT.length).toBeLessThan(200)
  })

  it('is still readable in /schedule list', () => {
    expect(AUDIT_TASK_PROMPT.replace(AUDIT_PROMPT_TOKEN, '').trim().length).toBeGreaterThan(0)
  })
})

describe('expandTaskPrompt', () => {
  it('swaps the token for the built prompt', () => {
    expect(expandTaskPrompt('before {{AUDIT_DIGEST}} after', () => 'DIGEST')).toBe('before DIGEST after')
  })

  it('leaves an ordinary task prompt alone and never builds a digest for it', () => {
    let built = 0
    const out = expandTaskPrompt('check my email', () => {
      built++
      return 'DIGEST'
    })
    expect(out).toBe('check my email')
    expect(built).toBe(0)
  })

  it('keeps the task running when the digest cannot be built', () => {
    const out = expandTaskPrompt('run it: {{AUDIT_DIGEST}}', () => {
      throw new Error('database is locked')
    })
    expect(out).not.toContain(AUDIT_PROMPT_TOKEN)
    expect(out).toMatch(/could not be/i)
  })
})

describe('ensureAuditTask', () => {
  it('creates the monthly task when the owner asked for it at setup', () => {
    const d = deps()
    expect(ensureAuditTask('chat-1', true, d)).toBe('created')
    expect(d.tasks).toHaveLength(1)
    expect(d.tasks[0]).toMatchObject({
      chatId: 'chat-1',
      name: AUDIT_TASK_NAME,
      schedule: AUDIT_SCHEDULE,
      deliveryMode: 'announce',
    })
    expect(d.tasks[0]?.prompt).toContain(AUDIT_PROMPT_TOKEN)
  })

  it('does nothing when the owner did not ask for it', () => {
    const d = deps()
    expect(ensureAuditTask('chat-1', false, d)).toBe('off')
    expect(d.tasks).toHaveLength(0)
  })

  it('seeds once, so deleting the task does not bring it back', () => {
    const d = deps()
    ensureAuditTask('chat-1', true, d)
    d.deleteTask(d.tasks[0]!.id)
    expect(ensureAuditTask('chat-1', true, d)).toBe('already-seeded')
    expect(d.tasks).toHaveLength(0)
  })

  it('does not create a second one when a task by that name already exists', () => {
    const d = deps()
    d.createTask({
      id: 'other',
      chatId: 'chat-1',
      name: AUDIT_TASK_NAME,
      prompt: 'x',
      schedule: AUDIT_SCHEDULE,
      nextRun: 1,
      deliveryMode: 'announce',
      timezone: 'UTC',
    })
    expect(ensureAuditTask('chat-1', true, d)).toBe('exists')
    expect(d.tasks).toHaveLength(1)
    expect(d.getState(AUDIT_SEEDED_KEY)).not.toBeNull()
  })

  it('schedules against the install timezone, not the host clock', () => {
    let asked: string | null = null
    const d = deps({
      timeZone: () => 'Europe/London',
      nextRun: (_schedule, tz) => {
        asked = tz
        return 42
      },
    })
    ensureAuditTask('chat-1', true, d)
    expect(asked).toBe('Europe/London')
    expect(d.tasks[0]?.nextRun).toBe(42)
  })
})

describe('setAuditSchedule', () => {
  it('turns it on even after the one-shot seed has been spent', () => {
    const d = deps()
    d.setState(AUDIT_SEEDED_KEY, 'yes')
    expect(setAuditSchedule('chat-1', true, d)).toBe('created')
    expect(d.tasks).toHaveLength(1)
  })

  it('is idempotent when it is already on', () => {
    const d = deps()
    setAuditSchedule('chat-1', true, d)
    expect(setAuditSchedule('chat-1', true, d)).toBe('exists')
    expect(d.tasks).toHaveLength(1)
  })

  it('removes the task when turned off', () => {
    const d = deps()
    setAuditSchedule('chat-1', true, d)
    expect(setAuditSchedule('chat-1', false, d)).toBe('removed')
    expect(d.tasks).toHaveLength(0)
  })

  it('says so when turning off something that was never on', () => {
    const d = deps()
    expect(setAuditSchedule('chat-1', false, d)).toBe('absent')
  })

  it('only touches this chat, so one member cannot cancel another', () => {
    const d = deps()
    setAuditSchedule('chat-1', true, d)
    setAuditSchedule('chat-2', true, d)
    setAuditSchedule('chat-1', false, d)
    expect(d.tasks.map((t) => t.chatId)).toEqual(['chat-2'])
    expect(findAuditTask('chat-2', d)).not.toBeNull()
    expect(findAuditTask('chat-1', d)).toBeNull()
  })
})
