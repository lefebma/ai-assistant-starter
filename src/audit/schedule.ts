/**
 * The monthly audit as a scheduled task.
 *
 * **Why the stored prompt is a token.** A scheduled task's prompt is written
 * into SQLite once and never read from source again, so whatever wording is
 * spelled out at creation time is stuck on that box for the life of the
 * install. Every previous attempt to improve a seeded job's prompt has run
 * into that. So the stored prompt here is a one-line label plus
 * `{{AUDIT_DIGEST}}`, and the scheduler swaps the token for the current
 * release's digest and instructions at run time. The wording stays soft; only
 * the token is frozen.
 *
 * **Why setup does not create the task itself.** The wizard runs before the
 * owner has messaged their bot, so ALLOWED_CHAT_ID is usually still blank and
 * there is no chat to schedule against. The wizard records the preference in
 * .env; the app seeds the task the first time a real chat turns up, once, the
 * same way the discovery-interview offer works. Once is the important half: an
 * owner who deletes the monthly audit has said something, and a box that
 * recreates it on the next restart is not listening.
 */

export const AUDIT_TASK_NAME = 'Monthly Assistant Audit'

/** 9am on the 1st. Early enough to be read, not so early it lands overnight. */
export const AUDIT_SCHEDULE = '0 9 1 * *'

export const AUDIT_PROMPT_TOKEN = '{{AUDIT_DIGEST}}'

/** Stored verbatim in SQLite. Keep it short: see the note above. */
export const AUDIT_TASK_PROMPT = `Monthly assistant audit. ${AUDIT_PROMPT_TOKEN}`

export const AUDIT_SEEDED_KEY = 'audit_task_seeded'

const TRUE_VALUES = new Set(['1', 'on', 'true', 'yes'])

/** Whether .env asks for the monthly audit. Off unless explicitly turned on. */
export function auditWanted(env: Record<string, string | undefined>): boolean {
  return TRUE_VALUES.has((env['MONTHLY_AUDIT'] ?? '').trim().toLowerCase())
}

export interface StoredTask {
  id: string
  chatId: string
  name: string | null
  prompt: string
  schedule: string
  nextRun: number
  deliveryMode: 'announce' | 'silent'
  timezone: string
}

export interface AuditScheduleDeps {
  getState(key: string): string | null
  setState(key: string, value: string): void
  listTasks(): StoredTask[]
  createTask(task: StoredTask): void
  deleteTask(id: string): boolean
  newId(): string
  nextRun(schedule: string, timezone: string): number
  timeZone(): string
}

/**
 * Swap the digest token for the current release's prompt.
 *
 * A failure here must not take the task down with it: a scheduled job that
 * throws is a job the owner finds out about a month later. The token is
 * replaced with an explanation instead, and the assistant reports the failure
 * to the owner in the reply it was going to send anyway.
 */
export function expandTaskPrompt(prompt: string, build: () => string): string {
  if (!prompt.includes(AUDIT_PROMPT_TOKEN)) return prompt
  let replacement: string
  try {
    replacement = build()
  } catch (err) {
    replacement = [
      'The usage digest could not be read on this run.',
      `Reason: ${err instanceof Error ? err.message : String(err)}`,
      'Tell the owner the audit could not read its own records this month, in one',
      'line, and do not write a usage report from memory.',
    ].join('\n')
  }
  return prompt.replace(AUDIT_PROMPT_TOKEN, replacement)
}

/** The monthly audit task belonging to this chat, if it exists. */
export function findAuditTask(chatId: string, deps: AuditScheduleDeps): StoredTask | null {
  return deps.listTasks().find((t) => t.chatId === chatId && t.name === AUDIT_TASK_NAME) ?? null
}

function create(chatId: string, deps: AuditScheduleDeps): void {
  const timezone = deps.timeZone()
  deps.createTask({
    id: deps.newId(),
    chatId,
    name: AUDIT_TASK_NAME,
    prompt: AUDIT_TASK_PROMPT,
    schedule: AUDIT_SCHEDULE,
    nextRun: deps.nextRun(AUDIT_SCHEDULE, timezone),
    deliveryMode: 'announce',
    timezone,
  })
}

export type EnsureResult = 'created' | 'exists' | 'already-seeded' | 'off'

/**
 * Act on the setup-time preference, exactly once per install.
 * Call it freely; it is cheap and self-guarding.
 */
export function ensureAuditTask(chatId: string, wanted: boolean, deps: AuditScheduleDeps): EnsureResult {
  if (!wanted) return 'off'
  if (deps.getState(AUDIT_SEEDED_KEY)) return 'already-seeded'
  if (findAuditTask(chatId, deps)) {
    deps.setState(AUDIT_SEEDED_KEY, new Date().toISOString())
    return 'exists'
  }
  create(chatId, deps)
  deps.setState(AUDIT_SEEDED_KEY, new Date().toISOString())
  return 'created'
}

export type SetResult = 'created' | 'exists' | 'removed' | 'absent'

/** The explicit /audit monthly on|off switch. Ignores the one-shot seed guard. */
export function setAuditSchedule(chatId: string, on: boolean, deps: AuditScheduleDeps): SetResult {
  const existing = findAuditTask(chatId, deps)
  if (on) {
    if (existing) return 'exists'
    create(chatId, deps)
    // Turning it on by hand also spends the seed, so the two paths cannot
    // race into two tasks on the next restart.
    deps.setState(AUDIT_SEEDED_KEY, new Date().toISOString())
    return 'created'
  }
  if (!existing) return 'absent'
  deps.deleteTask(existing.id)
  // Leave the seed spent: an owner who turned it off should not find it back
  // after a restart just because .env still says on.
  deps.setState(AUDIT_SEEDED_KEY, new Date().toISOString())
  return 'removed'
}
