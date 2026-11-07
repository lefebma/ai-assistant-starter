/**
 * Card #197: a scheduled run is reported complete only when the obligation
 * checker says so. Obligations come from the job's role, plus running to the
 * end; evidence comes from tool calls that succeeded, recorded by the
 * harness. Real db (own store dir), agent mocked: the mock plays the runtime,
 * calling recordToolEvidence the way the PostToolUse hook does.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-runobligations`
  return { runAgent: vi.fn(), sent: [] as Array<[string, string]>, failSend: false }
})

vi.mock('../src/agent.js', () => ({
  runAgent: h.runAgent,
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))

import { initDatabase, createTask, getTask, deleteTask, resumeTask } from '../src/db.js'
import { cancelScheduledTask, initScheduler, runDueTasks, stopScheduler } from '../src/scheduler.js'
import {
  evidenceTypes, obligationsFor, recordToolEvidence, trackRun, verdictNote, obligationNote, recordFinished, resetTrackedRuns, FINISHED,
} from '../src/assurance/run-obligations.js'
import { loadRunState } from '../src/assurance/run-state.js'
import { BUILTIN_ROLES } from '../src/assurance/roles.js'
import { getFileRoots, setFileRootsForTest } from '../src/web/files.js'
import { replyOrigin } from '../src/memory/provenance.js'
import { PROJECT_ROOT } from '../src/config.js'
import { relative } from 'node:path'

rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })

const due = () => Math.floor(Date.now() / 1000) - 60
const role = (id: string) => BUILTIN_ROLES.find((r) => r.id === id)!
const results = () => h.sent.filter(([, t]) => !t.startsWith('Running:'))

/** A runAgent whose tools ran these calls, then answered `text`. */
function agentRuns(calls: Array<[string, unknown]>, text: string | null) {
  h.runAgent.mockImplementationOnce(async () => {
    calls.forEach(([tool, input], i) => recordToolEvidence(`call-${Math.random()}-${i}`, tool, input))
    return { text }
  })
}

beforeAll(async () => {
  initDatabase()
  initScheduler(async (chatId, text) => {
    if (h.failSend && !text.startsWith('Running:') && !text.startsWith('Scheduled task')) throw new Error('chat unreachable')
    h.sent.push([chatId, text])
  })
  stopScheduler()
  await new Promise((r) => setTimeout(r, 10))
})

afterEach(() => {
  h.runAgent.mockReset()
  h.sent.length = 0
  h.failSend = false
  resetTrackedRuns()
})

describe('obligations come from the role first', () => {
  it('built-in roles owe what they are for, plus running to the end', () => {
    expect(obligationsFor(role('inbox-triage')).map((o) => o.evidenceType)).toEqual(['mail.read', 'run.finished'])
    expect(obligationsFor(role('briefing')).map((o) => o.evidenceType)).toEqual(['source.read', 'run.finished'])
    expect(obligationsFor(role('research')).map((o) => o.evidenceType)).toEqual(['web.read', 'run.finished'])
  })

  it('no role and the full role owe only the minimal default', () => {
    expect(obligationsFor(null)).toEqual([FINISHED])
    expect(obligationsFor(role('full'))).toEqual([FINISHED])
  })

  it('a roles.json role can list its own; a malformed entry is dropped', () => {
    const custom = { id: 'drafter', summary: '', tools: ['Bash'], obligations: [
      { id: 'drafts', description: 'save a draft reply', evidenceType: 'mail.drafted' },
      { id: 'bad', evidenceType: 'mail.read' },
      { id: 'zero', description: 'x', evidenceType: 'mail.read', minCount: 0 },
    ] } as never
    expect(obligationsFor(custom).map((o) => o.id)).toEqual(['drafts', 'finished'])
  })

  it('a role cannot replace or remove the default', () => {
    const custom = { id: 'x', summary: '', tools: ['*'], obligations: [{ id: 'finished', description: 'nothing', evidenceType: 'mail.read' }] } as never
    expect(obligationsFor(custom)).toEqual([FINISHED])
  })
})

describe('tool calls become evidence', () => {
  it('reads shell commands for what they did, compound ones included', () => {
    expect(evidenceTypes('Bash', { command: 'gog gmail search "is:unread" --max 20' })).toEqual(expect.arrayContaining(['mail.read', 'source.read']))
    expect(evidenceTypes('Bash', { command: 'node dist/scripts/ms-mail.js inbox --top 10 && node /x/ms-mail.js draft --to a@b' })).toEqual(expect.arrayContaining(['mail.read', 'mail.drafted']))
    // The account can come before the subcommand (review).
    expect(evidenceTypes('Bash', { command: 'gog --account a@b.co gmail read 12' })).toContain('mail.read')
    expect(evidenceTypes('Bash', { command: 'gog -a a@b.co --json calendar events' })).toContain('calendar.read')
    expect(evidenceTypes('Bash', { command: 'gog --account a@b.co gmail send' })).not.toContain('mail.read')
    expect(evidenceTypes('Bash', { command: 'gog calendar events --today' })).toEqual(expect.arrayContaining(['calendar.read', 'source.read']))
    expect(evidenceTypes('bash', { command: 'curl -s https://example.com' })).toEqual(expect.arrayContaining(['web.read']))
    expect(evidenceTypes('WebSearch', { query: 'x' })).toEqual(['web.read', 'source.read'])
  })

  it('counts only commands whose failure would have shown', () => {
    // Followed by ; or ||, or after ||: a failure there is hidden by the exit status.
    expect(evidenceTypes('Bash', { command: 'gog gmail search x; echo ok' })).toEqual([])
    expect(evidenceTypes('Bash', { command: 'gog gmail search x || true' })).toEqual([])
    expect(evidenceTypes('Bash', { command: 'true || gog gmail search x' })).toEqual([])
    expect(evidenceTypes('Bash', { command: 'echo start; gog gmail search x' })).toContain('mail.read')
    expect(evidenceTypes('Bash', { command: 'cd /tmp && gog gmail search x' })).toContain('mail.read')
    expect(evidenceTypes('Bash', { command: 'gog gmail search x &' })).toEqual([])
  })

  it('a piped mail command counts only when the pipe produced output', () => {
    const cmd = { command: 'gog gmail search "is:unread" --json | jq ".[0]"' }
    expect(evidenceTypes('Bash', cmd, { stdout: '', stderr: 'auth error', interrupted: false })).toEqual([])
    expect(evidenceTypes('Bash', cmd, { stdout: '{"id":"1"}', stderr: '', interrupted: false })).toContain('mail.read')
    expect(evidenceTypes('bash', cmd, '{"id":"1"}')).toContain('mail.read')
  })

  it('an interrupted or backgrounded command has not finished', () => {
    const cmd = { command: 'gog gmail search x' }
    expect(evidenceTypes('Bash', cmd, { stdout: 'x', interrupted: true })).toEqual([])
    expect(evidenceTypes('Bash', cmd, { stdout: '', interrupted: false, backgroundTaskId: 'b1' })).toEqual([])
  })

  it('curl counts only when it fetches an address', () => {
    expect(evidenceTypes('Bash', { command: 'curl --version' })).toEqual([])
    expect(evidenceTypes('Bash', { command: 'curl -s "https://example.com/a?b=1&c=2"' })).toContain('web.read')
  })

  it('a command that only talks about the inbox proves nothing', () => {
    expect(evidenceTypes('Bash', { command: 'echo "gog gmail search done"' })).toEqual([])
    expect(evidenceTypes('Bash', { command: 'ls inbox' })).toEqual([])
    expect(evidenceTypes('Read', { file_path: 'mail.txt' })).toEqual([])
  })

  it('evidence counts only inside a tracked run, and the same call counts once', () => {
    expect(recordToolEvidence('c1', 'Bash', { command: 'gog gmail search x' }, undefined, 'job:none')).toBe(0)
    const run = trackRun('job:t-evidence', obligationsFor(role('inbox-triage')))
    expect(recordToolEvidence('c1', 'Bash', { command: 'gog gmail search x' }, undefined, 'job:t-evidence')).toBe(1)
    expect(recordToolEvidence('c1', 'Bash', { command: 'gog gmail search x' }, undefined, 'job:t-evidence')).toBe(0)
    expect(recordToolEvidence('c2', 'Bash', { command: 'gog gmail read 123' }, undefined, 'job:t-evidence')).toBe(1)
    run.end()
    expect(recordToolEvidence('c3', 'Bash', { command: 'gog gmail read 4' }, undefined, 'job:t-evidence')).toBe(0)
  })

  it('the model saying it finished is not evidence', () => {
    const run = trackRun('job:t-model', obligationsFor(null))
    expect(run.authority.record({ eventId: 'm', runId: 'job:t-model', origin: 'model', evidenceType: 'run.finished', obligationId: 'finished' }).accepted).toBe(false)
    expect(run.authority.requestCompletion().status).toBe('incomplete')
    recordFinished(run)
    expect(run.authority.requestCompletion().status).toBe('complete')
  })
})

describe('the owner is told what the checker says', () => {
  it('notes name what is missing in plain words', () => {
    const obs = obligationsFor(role('inbox-triage'))
    expect(verdictNote({ status: 'complete', version: 1, unmet: [] }, obs)).toBeNull()
    expect(verdictNote({ status: 'incomplete', version: 1, unmet: [{ id: 'mail-read', have: 0, need: 1 }] }, obs)).toContain('read the inbox')
    expect(verdictNote({ status: 'unknown', version: 1, unmet: [], reason: 'cut off' }, obs)).toContain("can't confirm")
    expect(obligationNote(obs)).toContain('read the inbox')
    expect(obligationNote(obligationsFor(null))).toBe('')
  })
})

describe('scheduled runs report the verdict, not the model', () => {
  it('a triage job that read the inbox is reported as usual', async () => {
    createTask('o-1', 'chat-o', 'triage the inbox', '0 9 * * *', due(), 'Triage', 'announce', 'America/Toronto', false, 'inbox-triage')
    agentRuns([['Bash', { command: 'gog gmail search "is:unread"' }]], 'Two drafts saved.')
    await runDueTasks()
    expect(results()).toEqual([['chat-o', 'Triage:\n\nTwo drafts saved.']])
    expect(getTask('o-1')!.last_result).toBe('Two drafts saved.')
    // The job was told what it is checked on.
    expect(h.runAgent.mock.calls[0][0]).toContain('read the inbox')
  })

  it('a triage job that says "done" without reading the inbox is reported as not finished', async () => {
    createTask('o-2', 'chat-o', 'triage the inbox', '0 9 * * *', due(), 'Triage', 'announce', 'America/Toronto', false, 'inbox-triage')
    agentRuns([], 'All done, inbox triaged.')
    await runDueTasks()
    const [[, text]] = results()
    expect(text).toMatch(/^Triage:\n\nNot finished: .*read the inbox/)
    expect(text).toContain('All done, inbox triaged.')
    expect(getTask('o-2')!.last_result).toMatch(/^INCOMPLETE: /)
  })

  it('a silent job may stay quiet only when complete', async () => {
    createTask('o-3', 'chat-o', 'check', '0 9 * * *', due(), 'Quiet check', 'silent', 'America/Toronto', false, 'inbox-triage')
    agentRuns([['Bash', { command: 'gog gmail search x' }]], 'HEARTBEAT_OK')
    await runDueTasks()
    expect(results()).toEqual([])

    createTask('o-4', 'chat-o', 'check', '0 9 * * *', due(), 'Quiet check', 'silent', 'America/Toronto', false, 'inbox-triage')
    agentRuns([], 'HEARTBEAT_OK')
    await runDueTasks()
    expect(results()).toHaveLength(1)
    expect(results()[0][1]).toContain('Not finished')
  })

  it('a job with no role owes only an answer; an empty one is reported', async () => {
    createTask('o-5', 'chat-o', 'say hi', '0 9 * * *', due(), 'Hello', 'announce')
    agentRuns([], 'Hi.')
    await runDueTasks()
    expect(results()).toEqual([['chat-o', 'Hello:\n\nHi.']])

    h.sent.length = 0
    createTask('o-6', 'chat-o', 'say hi', '0 9 * * *', due(), 'Hello', 'announce')
    agentRuns([], null)
    await runDueTasks()
    expect(results()[0][1]).toContain('run to the end and write its answer')
  })

  it('a run that throws, or whose answer cannot be delivered, is recorded as failed', async () => {
    createTask('o-7', 'chat-o', 'x', '0 9 * * *', due(), 'Boom', 'announce')
    const t7 = getTask('o-7')!
    h.runAgent.mockImplementationOnce(async () => { throw new Error('kaboom') })
    await runDueTasks()
    expect(results().some(([, t]) => t.includes('failed'))).toBe(true)
    expect(loadRunState(`job:o-7@${t7.next_run}`)?.terminal?.status).toBe('failed')

    createTask('o-8', 'chat-o', 'x', '0 9 * * *', due(), 'Lost', 'announce')
    const t8 = getTask('o-8')!
    h.failSend = true
    agentRuns([], 'Answer.')
    await runDueTasks()
    expect(loadRunState(`job:o-8@${t8.next_run}`)?.terminal).toMatchObject({ status: 'failed' })
  })
})

describe('the Claude Code hook', () => {
  it('records a call that succeeded and ignores one that failed', async () => {
    const { evidenceHook } = await import('../src/runtime/claude.js')
    const { withRun } = await import('../src/assurance/effect-journal.js')
    const run = trackRun('job:t-hook', obligationsFor(role('inbox-triage')))
    const base = { session_id: 's', transcript_path: '', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'gog gmail search x' } }
    await withRun('job:t-hook', () => evidenceHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_use_id: 'u1', error: 'exit 1' } as never))
    expect(run.authority.requestCompletion().unmet.map((u) => u.id)).toContain('mail-read')
    await withRun('job:t-hook', () => evidenceHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 'u2', tool_response: { stdout: '' } } as never))
    expect(run.authority.requestCompletion().unmet.map((u) => u.id)).toEqual(['finished'])
    run.end()
  })
})

describe('the overload retry shares the run', () => {
  const OVERLOADED = 'API is temporarily overloaded. Try again shortly.'

  it('evidence from the first attempt counts, and the retry is reported by the checker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      createTask('o-9', 'chat-o', 'triage', '0 9 * * *', due(), 'Retry triage', 'announce', 'America/Toronto', false, 'inbox-triage')
      // First attempt read the inbox, then hit the overload.
      agentRuns([['Bash', { command: 'gog gmail search x' }]], OVERLOADED)
      await runDueTasks()
      expect(getTask('o-9')!.last_result).toMatch(/^DEFERRED/)
      agentRuns([], 'Drafts saved.')
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(results()).toEqual([['chat-o', 'Retry triage:\n\nDrafts saved.']])
      expect(getTask('o-9')!.last_result).toBe('Drafts saved.')
    } finally { vi.useRealTimers() }
  })

  it('a retry that throws is recorded as failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      createTask('o-10', 'chat-o', 'x', '0 9 * * *', due(), 'Retry boom', 'announce')
      const t = getTask('o-10')!
      agentRuns([], OVERLOADED)
      await runDueTasks()
      h.runAgent.mockImplementationOnce(async () => { throw new Error('kaboom') })
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(loadRunState(`job:o-10@${t.next_run}`)?.terminal?.status).toBe('failed')
    } finally { vi.useRealTimers() }
  })
})

describe('runs never stay open, and a closed one does not haunt the next', () => {
  const OVERLOADED = 'API is temporarily overloaded. Try again shortly.'

  /** A runAgent that waits for its signal, then resolves like a cancelled turn. */
  function runsUntilCancelled(): Promise<void> {
    let started!: () => void
    const p = new Promise<void>((r) => { started = r })
    h.runAgent.mockImplementationOnce((...args: unknown[]) => {
      const signal = args[6] as AbortSignal
      started()
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: null }), { once: true }))
    })
    return p
  }

  it('a cancelled one-shot, resumed later, is a fresh run that can be complete', async () => {
    createTask('o-11', 'chat-o', 'triage', '0 9 * * *', due(), 'Once', 'silent', 'America/Toronto', true, 'inbox-triage')
    const started = runsUntilCancelled()
    const run = runDueTasks()
    await started
    cancelScheduledTask('o-11')
    await run
    expect(loadRunState('job:o-11')?.terminal?.status).toBe('cancelled')

    resumeTask('o-11', due())
    h.sent.length = 0
    agentRuns([['Bash', { command: 'gog gmail search x' }]], 'HEARTBEAT_OK')
    await runDueTasks()
    // Complete, so the silent one-shot stays quiet and is deleted.
    expect(results()).toEqual([])
    expect(getTask('o-11')).toBeUndefined()
  })

  it('deleting a job mid-run closes its run as cancelled', async () => {
    createTask('o-12', 'chat-o', 'x', '0 9 * * *', due(), 'Doomed', 'announce')
    const t = getTask('o-12')!
    const started = runsUntilCancelled()
    const run = runDueTasks()
    await started
    cancelScheduledTask('o-12')
    deleteTask('o-12')
    await run
    expect(loadRunState(`job:o-12@${t.next_run}`)?.terminal?.status).toBe('cancelled')
  })

  it('cancelling a waiting retry closes the run; overloaded twice is failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      createTask('o-13', 'chat-o', 'x', '0 9 * * *', due(), 'Wait', 'announce')
      const t13 = getTask('o-13')!
      agentRuns([], OVERLOADED)
      await runDueTasks()
      cancelScheduledTask('o-13')
      expect(loadRunState(`job:o-13@${t13.next_run}`)?.terminal?.status).toBe('cancelled')

      createTask('o-14', 'chat-o', 'x', '0 9 * * *', due(), 'Twice', 'announce')
      const t14 = getTask('o-14')!
      agentRuns([], OVERLOADED)
      await runDueTasks()
      agentRuns([], OVERLOADED)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(loadRunState(`job:o-14@${t14.next_run}`)?.terminal?.status).toBe('failed')
    } finally { vi.useRealTimers() }
  })
})

describe('reading a project file is an outside read (card #280)', () => {
  const uploads = '/tmp/havn-test-uploads'
  const proj = `${uploads}/projects/p1/a.md`
  afterEach(() => setFileRootsForTest(null))

  it('Read and read_file of a project file give file.read, absolute or relative', () => {
    setFileRootsForTest({ root: '/tmp/havn-test-root', uploadsDir: uploads })
    expect(evidenceTypes('Read', { file_path: proj })).toContain('file.read')
    expect(evidenceTypes('read_file', { path: proj })).toContain('file.read')
    expect(evidenceTypes('read_file', { path: relative(PROJECT_ROOT, proj) })).toContain('file.read')
    // It is not a mail, web or calendar read, so a briefing does not count it.
    expect(evidenceTypes('Read', { file_path: proj })).not.toContain('source.read')
  })

  it('follows the roots at call time', () => {
    setFileRootsForTest({ root: '/tmp/x', uploadsDir: '/tmp/other-uploads' })
    expect(evidenceTypes('Read', { file_path: proj })).not.toContain('file.read')
    expect(evidenceTypes('Read', { file_path: '/tmp/other-uploads/projects/p1/a.md' })).toContain('file.read')
  })

  it('a shell read of a project file gives file.read', () => {
    setFileRootsForTest({ root: '/tmp/havn-test-root', uploadsDir: uploads })
    expect(evidenceTypes('Bash', { command: `cat ${proj}` }, 'text')).toContain('file.read')
    expect(evidenceTypes('Bash', { command: `cat "${proj}"` }, 'text')).toContain('file.read')
    expect(evidenceTypes('Bash', { command: 'cat workspace/uploads/projects/p1/a.md' }, 'text')).toContain('file.read')
    expect(evidenceTypes('Bash', { command: 'ls /tmp' }, 'text')).not.toContain('file.read')
  })

  it('other files and paths that .. out of the projects folder do not count', () => {
    setFileRootsForTest({ root: '/tmp/havn-test-root', uploadsDir: uploads })
    expect(evidenceTypes('Read', { file_path: `${PROJECT_ROOT}/README.md` })).not.toContain('file.read')
    expect(evidenceTypes('Read', { file_path: `${uploads}/projects/../chat/c1/a.md` })).not.toContain('file.read')
    expect(evidenceTypes('Read', { file_path: `${uploads}/projects-other/a.md` })).not.toContain('file.read')
    expect(evidenceTypes('Read', { file_path: `${uploads}/projects/p1/../p2/b.md` })).toContain('file.read')
    expect(getFileRoots().uploadsDir).toBe(uploads)
  })

  it('a reply built on such a read is stored as untrusted', () => {
    expect(replyOrigin(['file.read'])).toBe('untrusted')
  })
})
