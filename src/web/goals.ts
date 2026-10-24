/**
 * Goals for the web UI: the bullets of the Priorities section of PROFILE.md,
 * the same source the briefing and audit read. Writes touch only the bullet
 * line involved (or append one), are atomic, and refuse when the file changed
 * since the client read it.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { PROFILE_STUB_MARKER } from '../onboarding/interview-offer.js'

export interface Goal {
  index: number
  text: string
  done: boolean
}
export interface GoalsResult {
  goals: Goal[]
  /** sha256 of the file content, or 'none' when PROFILE.md does not exist. */
  version: string
}

export class GoalConflict extends Error {
  constructor() {
    super('goals_changed')
  }
}
export class GoalInvalid extends Error {
  constructor(code: string) {
    super(code)
  }
}

const MAX_GOAL = 300
const BULLET = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*?)\s*$/

const profilePath = (root: string) => join(root, 'PROFILE.md')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

function load(root: string): { raw: string | null; version: string } {
  try {
    const raw = readFileSync(profilePath(root), 'utf-8')
    return { raw, version: hash(raw) }
  } catch {
    return { raw: null, version: 'none' }
  }
}

interface Section {
  /** Line index of the heading. */
  heading: number
  /** Line indices of the bullets, in order. */
  bullets: number[]
}

/** First Priorities heading, and the bullets up to the next heading of the same or higher level. */
function findSection(lines: string[]): Section | null {
  let fence = false
  let start = -1
  let level = 0
  const bullets: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (/^(```|~~~)/.test(t)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = /^(#{1,6})\s*(.*)$/.exec(t)
    if (h) {
      if (start >= 0) {
        if (h[1]!.length <= level) break
        continue
      }
      if (/^priorit/i.test(h[2]!)) {
        start = i
        level = h[1]!.length
      }
      continue
    }
    if (start >= 0 && BULLET.test(lines[i]!)) bullets.push(i)
  }
  return start >= 0 ? { heading: start, bullets } : null
}

function parse(raw: string | null): { goals: Goal[]; lines: string[]; section: Section | null } {
  const lines = (raw ?? '').split('\n')
  const section = raw === null ? null : findSection(lines)
  const goals = (section?.bullets ?? []).map((ln, index) => {
    const m = BULLET.exec(lines[ln]!)!
    return { index, text: m[3]!, done: (m[2] ?? ' ').toLowerCase() === 'x' }
  })
  return { goals, lines, section }
}

export function readGoals(root: string = PROJECT_ROOT): GoalsResult {
  const { raw, version } = load(root)
  return { goals: parse(raw).goals, version }
}

function cleanText(text: unknown): string {
  if (typeof text !== 'string' || /[\r\n]/.test(text)) throw new GoalInvalid('bad_text')
  const t = text.trim()
  if (!t || t.length > MAX_GOAL) throw new GoalInvalid('bad_text')
  return t
}

function writeAtomic(root: string, content: string): void {
  const target = profilePath(root)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, target)
}

/** Run a mutation on the lines. Checks the version first; the file is untouched on any throw. */
function mutate(
  version: string,
  root: string,
  fn: (p: ReturnType<typeof parse>, raw: string | null) => string,
): GoalsResult {
  const cur = load(root)
  if (typeof version !== 'string' || version !== cur.version) throw new GoalConflict()
  const out = fn(parse(cur.raw), cur.raw)
  writeAtomic(root, out)
  return readGoals(root)
}

const line = (indent: string, text: string, done: boolean, cr: string) => `${indent}- [${done ? 'x' : ' '}] ${text}${cr}`

function target(p: ReturnType<typeof parse>, index: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= p.goals.length) throw new GoalInvalid('bad_index')
  return p.section!.bullets[index]!
}

export function addGoal(text: string, version: string, root: string = PROJECT_ROOT): GoalsResult {
  const t = cleanText(text)
  return mutate(version, root, (p, raw) => {
    if (raw === null) return `## Priorities\n\n- [ ] ${t}\n`
    // The scaffolded stub says "No profile yet" and carries the marker that
    // makes the audit, the briefing and the interview offer treat the profile
    // as unwritten. Goals appended below it would be invisible to all three
    // (the audit reads Priorities only from a written profile), so the first
    // goal replaces the stub with a minimal profile instead. The owner can
    // still start the discovery interview by asking for it.
    if (raw.includes(PROFILE_STUB_MARKER)) return `# Profile\n\n## Priorities\n\n- [ ] ${t}\n`
    if (!p.section) {
      return `${raw.replace(/\s*$/, '')}\n\n## Priorities\n\n- [ ] ${t}\n`
    }
    const lines = p.lines.slice()
    const last = p.section.bullets.at(-1)
    if (last !== undefined) {
      const cr = lines[last]!.endsWith('\r') ? '\r' : ''
      lines.splice(last + 1, 0, line('', t, false, cr))
    } else {
      const h = p.section.heading
      if (lines[h + 1] === undefined || lines[h + 1]!.trim() === '') lines.splice(h + 2, 0, line('', t, false, ''))
      else lines.splice(h + 1, 0, '', line('', t, false, ''), '')
    }
    return lines.join('\n')
  })
}

export function updateGoal(index: number, text: string, version: string, root: string = PROJECT_ROOT): GoalsResult {
  const t = cleanText(text)
  return mutate(version, root, (p) => {
    const ln = target(p, index)
    const m = BULLET.exec(p.lines[ln]!)!
    const cr = p.lines[ln]!.endsWith('\r') ? '\r' : ''
    const lines = p.lines.slice()
    lines[ln] = line(m[1]!, t, (m[2] ?? ' ').toLowerCase() === 'x', cr)
    return lines.join('\n')
  })
}

export function setGoalDone(index: number, done: boolean, version: string, root: string = PROJECT_ROOT): GoalsResult {
  if (typeof done !== 'boolean') throw new GoalInvalid('bad_done')
  return mutate(version, root, (p) => {
    const ln = target(p, index)
    const m = BULLET.exec(p.lines[ln]!)!
    const cr = p.lines[ln]!.endsWith('\r') ? '\r' : ''
    const lines = p.lines.slice()
    lines[ln] = line(m[1]!, m[3]!, done, cr)
    return lines.join('\n')
  })
}

export function deleteGoal(index: number, version: string, root: string = PROJECT_ROOT): GoalsResult {
  return mutate(version, root, (p) => {
    const ln = target(p, index)
    const lines = p.lines.slice()
    lines.splice(ln, 1)
    return lines.join('\n')
  })
}

export const profileExists = (root: string = PROJECT_ROOT) => existsSync(profilePath(root))
