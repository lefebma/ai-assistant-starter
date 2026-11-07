/**
 * The obligation checker wired into scheduled runs (card #197, on #168 and
 * #234).
 *
 * Before a scheduled job starts, the harness writes what it owes: what its
 * role says the job is for (an inbox triage reads the inbox), plus, for every
 * job, that it ran to the end. Tool calls that succeed are turned into
 * evidence here, by the harness, from what the tool actually did. The model
 * never records anything. When the run ends the scheduler asks the checker,
 * and only a "complete" verdict is reported as done.
 *
 * Obligations come from the role first (Marc's call, 2026-11-04): a role in
 * roles.json can list its own `obligations`, and the built-in roles have
 * defaults below. A job with no role, or the `full` role, only owes the
 * minimal default, so a crash, a cut-off or an empty answer still shows.
 *
 * Evidence is keyed by the run key the effect journal already uses
 * (`job:<id>`, `job:<id>@<due>`), and the state is on disk (run-state.ts), so
 * a run resumed after a restart keeps what it already proved.
 */
import { currentRun } from './effect-journal.js'
import type { AuthorityFacet, Obligation, Verdict } from './obligations.js'
import { canonicalTool, type RoleSpec } from './roles.js'
import { noteReads } from '../memory/turn-context.js'
import { PROJECT_ROOT } from '../config.js'
import { getFileRoots } from '../web/files.js'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { dropRunState, loadRunState, openRun } from './run-state.js'

/** Effectively unlimited: reading the inbox twice is fine, it is not a send. */
const MANY = 1_000_000

/** Every job owes this one: the run reached the end and produced an answer. */
export const FINISHED: Obligation = { id: 'finished', description: 'run to the end and write its answer', evidenceType: 'run.finished', minCount: 1, maxCount: 1 }

/** What the built-in roles are for. A role in roles.json may set its own. */
export const ROLE_OBLIGATIONS: Record<string, Obligation[]> = {
  'inbox-triage': [{ id: 'mail-read', description: 'read the inbox', evidenceType: 'mail.read', minCount: 1, maxCount: MANY }],
  briefing: [{ id: 'source-read', description: 'read at least one source (email, calendar or the web)', evidenceType: 'source.read', minCount: 1, maxCount: MANY }],
  research: [{ id: 'web-read', description: 'read at least one web page or search result', evidenceType: 'web.read', minCount: 1, maxCount: MANY }],
  full: [],
}

/** The obligations a run starts with: the role's, then the minimal default. */
export function obligationsFor(role: RoleSpec | null): Obligation[] {
  const own = role ? (Array.isArray(role.obligations) ? role.obligations.filter(validObligation) : ROLE_OBLIGATIONS[role.id] ?? []) : []
  return [...own.filter((o) => o.id !== FINISHED.id).map((o) => ({ ...o, maxCount: o.maxCount ?? MANY })), FINISHED]
}

/** roles.json is hand-written: an entry that cannot be checked is dropped. */
function validObligation(o: unknown): o is Obligation {
  if (!o || typeof o !== 'object') return false
  const x = o as Record<string, unknown>
  const count = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1)
  return typeof x.id === 'string' && x.id.length > 0 && typeof x.description === 'string' && typeof x.evidenceType === 'string' && count(x.minCount) && count(x.maxCount)
}

// --- tool results to evidence --------------------------------------------------

const MAIL_READ = ['gog gmail search', 'gog gmail read', 'gog gmail thread', 'ms-mail.js inbox', 'ms-mail.js search', 'ms-mail.js read', 'imap-mail.js inbox', 'imap-mail.js search', 'imap-mail.js read']
const MAIL_DRAFT = ['gog gmail drafts create', 'gog gmail drafts update', 'ms-mail.js draft', 'ms-mail.js reply', 'imap-mail.js draft', 'imap-mail.js reply']
const CALENDAR_READ = ['gog calendar events', 'gog calendar list', 'ms-calendar.js today', 'ms-calendar.js range']
const WEB_COMMANDS = ['curl', 'wget']
const WEB_TOOLS = ['WebSearch', 'WebFetch', 'mcp__playwright__browser_navigate', 'mcp__playwright__browser_snapshot']

/**
 * The folder project files live in. Resolved at call time: tests swap the
 * roots, and a module-level constant would keep the old one.
 */
function projectsRoot(): string {
  return realish(resolve(getFileRoots().uploadsDir, 'projects'))
}

/** realpath of a path, or of its nearest existing parent plus the rest, so a symlink is judged by where it points. */
function realish(p: string): string {
  const tail: string[] = []
  let cur = p
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail.reverse()) } catch { /* not there yet */ }
    const up = dirname(cur)
    if (up === cur) return p
    tail.push(basename(cur))
    cur = up
  }
}

/** Case-insensitive filesystems (macOS, Windows) compare lower-cased. */
const fold = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p)
const within = (path: string, dir: string) => { const a = fold(path), d = fold(dir); return a === d || a.startsWith(d + sep) }

/** The first path a file tool names, resolved against the run's working directory. */
function toolPath(input: unknown, cwd: string): string | undefined {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const p = [o.file_path, o.path].find((x): x is string => typeof x === 'string' && x.length > 0)
  return p === undefined ? undefined : realish(resolve(cwd, p))
}

/** True when a file tool's path lands inside the projects folder (.. , symlinks and relative paths resolved). */
function inProjectFiles(input: unknown, cwd: string): boolean {
  const p = toolPath(input, cwd)
  return !!p && within(p, projectsRoot())
}

/**
 * A search or listing (Grep, Glob, LS) reads project files when its root is
 * inside the projects folder or above it: a search with no path covers the
 * working directory, which holds uploads/projects.
 */
function searchesProjectFiles(input: unknown, cwd: string): boolean {
  const root = projectsRoot()
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const base = toolPath(input, cwd) ?? realish(resolve(cwd))
  if (within(base, root) || within(root, base)) return true
  // A glob that names the folder itself, from a root that is not above it.
  if (typeof o.pattern === 'string') {
    const lead = o.pattern.split(/[*?[{]/)[0]
    const at = realish(resolve(base, lead || '.'))
    if (within(at, root) || within(root, at)) return true
  }
  return false
}

/** True when a shell command names the projects folder, by full path or as uploads/projects. */
function mentionsProjectFiles(cmd: string): boolean {
  const abs = resolve(getFileRoots().uploadsDir, 'projects')
  return cmd.includes(abs) || cmd.includes(projectsRoot()) || /(?:^|[\s/'"=])uploads\/projects(?![\w-])/.test(cmd)
}

/** True when a path (resolved against cwd) is in or above the projects folder. */
function reachesProjectFiles(p: string, cwd: string): boolean {
  if (/[*?[{$`]/.test(p)) return true // a glob or variable could expand to it: fail closed
  const home = process.env.HOME ?? ''
  const at = realish(resolve(cwd, p.startsWith('~') && home ? join(home, p.slice(1)) : p))
  const root = projectsRoot()
  return within(at, root) || within(root, at)
}

const RECURSIVE_ALWAYS = new Set(['rg', 'ag', 'ack', 'find', 'tar', 'zip'])

/**
 * A shell command that walks directories (grep -r, rg, find, ls -R, tar, zip)
 * reads project files when it runs with no path from a cwd at or above the
 * folder, or names a path that is. Quoting is only roughly understood: this
 * leans towards counting.
 */
function walksProjectFiles(cmd: string, cwd: string): boolean {
  for (const seg of cmd.split(/&&|\|\||[;|&\n]/)) {
    const toks = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, ''))
    while (toks.length && /^[A-Za-z_]\w*=/.test(toks[0])) toks.shift()
    const prog = toks.shift()?.split('/').pop()
    if (!prog) continue
    const args = toks
    const flags = args.filter((a) => a.startsWith('-') && a.length > 1)
    const short = flags.filter((f) => !f.startsWith('--')).map((f) => f.slice(1)).join('')
    const recursive =
      RECURSIVE_ALWAYS.has(prog) ||
      (/^(?:grep|egrep|fgrep)$/.test(prog) && (/[rR]/.test(short) || flags.some((f) => f === '--recursive' || f === '--dereference-recursive'))) ||
      (prog === 'ls' && /R/.test(short))
    if (!recursive) continue
    let paths: string[]
    if (prog === 'find') {
      const i = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!')
      paths = i < 0 ? args : args.slice(0, i)
      if (!paths.length) paths = ['.']
    } else {
      let pos = args.filter((a) => !a.startsWith('-'))
      // The first positional is the pattern for the searchers, unless -e/-f supplied it.
      if (/^(?:grep|egrep|fgrep|rg|ag|ack)$/.test(prog) && !flags.some((f) => /^-[a-zA-Z]*[ef]$|^--(?:regexp|file)/.test(f))) pos = pos.slice(1)
      paths = pos.length ? pos : ['.']
    }
    if (paths.some((p) => reachesProjectFiles(p, cwd))) return true
  }
  return false
}

// Background shells seen this process: id -> did the command touch project files.
const shellTouched = new Map<string, boolean>()

/** "node /x/dist/scripts/ms-mail.js read 12" -> ["ms-mail.js", "read", "12"]. */
function words(segment: string): string[] {
  const t = segment.replace(/^(?:\s*[A-Za-z_]\w*=\S*\s+)+/, '').trim().split(/\s+/).filter(Boolean)
  if ((t[0] === 'node' || t[0] === 'npx') && t[1]) t.shift()
  if (t[0]) t[0] = t[0].split('/').pop()!
  // `gog --account x gmail read` is the same command as `gog gmail read`.
  if (t[0] === 'gog') {
    let i = 1
    while (t[i]?.startsWith('-')) i += /^(?:--account|--acct|-a|--client)$/.test(t[i]!) ? 2 : 1
    t.splice(1, i - 1)
  }
  return t
}

const starts = (w: string[], prefixes: string[]) => prefixes.some((p) => p.split(' ').every((x, i) => w[i] === x))

type Op = '&&' | '||' | ';' | '|' | '&'

/**
 * A shell command as its simple commands and the operator after each, outside
 * quotes. Same reading as roles.splitSegments (continuations join, quoted
 * text stays one argument), keeping the operators so the caller can tell
 * which commands' failures would have reached the exit status.
 */
function chain(cmd: string): Array<{ seg: string; after: Op | null }> {
  const out: Array<{ seg: string; after: Op | null }> = []
  let cur = ''
  const push = (op: Op | null) => { out.push({ seg: cur.trim(), after: op }); cur = '' }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\' && cmd[i + 1] === '\n') { cur += ' '; i++; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < cmd.length && cmd[j] !== c) j += c === '"' && cmd[j] === '\\' ? 2 : 1
      cur += 'Q'
      i = j
      continue
    }
    const two = cmd.slice(i, i + 2)
    if (two === '&&' || two === '||') { push(two); i++; continue }
    if (c === ';' || c === '\n') { push(';'); continue }
    if (c === '|') { push('|'); continue }
    if (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { push('&'); continue }
    cur += c
  }
  push(null)
  return out.filter((x) => x.seg)
}

/**
 * The simple commands of `cmd` that certainly ran and succeeded, given that
 * the whole command exited 0. A command counts when every operator after it
 * is && (its failure would have stopped the chain and failed the command) and
 * it did not follow ||. A command piped into another hides its own exit
 * status, so it counts only if the pipe produced output: a mail search that
 * failed prints its error to stderr and nothing to the pipe.
 */
function certainSegments(cmd: string, stdout: string | undefined): string[] {
  const parts = chain(cmd)
  const piped = parts.some((p) => p.after === '|')
  const hasOutput = typeof stdout === 'string' && stdout.trim().length > 0
  return parts.filter((p, i) => {
    if (i > 0 && parts[i - 1].after === '||') return false
    const rest = parts.slice(i).map((x) => x.after).filter((op): op is Op => op !== null)
    if (!rest.every((op) => op === '&&' || op === '|')) return false
    return !piped || !rest.includes('|') || hasOutput
  }).map((p) => p.seg)
}

/**
 * What a tool call that succeeded shows was done, as evidence types. A shell
 * command counts for each kind of command it certainly ran (mail read, draft
 * saved, calendar read, web read); see certainSegments. `output` is what the
 * tool returned. Exported for tests.
 */
export function evidenceTypes(tool: string, input: unknown, output?: unknown, cwd: string = PROJECT_ROOT): string[] {
  const name = canonicalTool(tool)
  const out = new Set<string>()
  if (WEB_TOOLS.includes(name)) out.add('web.read')
  if (name === 'Write' || name === 'Edit') out.add('file.written')
  // A project file holds text the owner may have imported from elsewhere: an outside read.
  if (name === 'Read' && inProjectFiles(input, cwd)) out.add('file.read')
  if ((name === 'Grep' || name === 'Glob' || name === 'LS') && searchesProjectFiles(input, cwd)) out.add('file.read')
  if (name === 'BashOutput' || name === 'TaskOutput') {
    // Output of a background shell: counts if that shell's command touched the folder,
    // or if we never saw it start (a restart, another process): fail closed.
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const id = [o.bash_id, o.shell_id, o.task_id, o.id].find((x) => typeof x === 'string' || typeof x === 'number')
    if (id === undefined || shellTouched.get(String(id)) !== false) out.add('file.read')
  }
  if (name === 'Bash') {
    const cmd = typeof input === 'object' && input && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : ''
    // Any mention counts, even in a command that failed or may not have run:
    // missing a read is the failure, over-counting is not.
    const touched = mentionsProjectFiles(cmd) || walksProjectFiles(cmd, cwd)
    if (touched) out.add('file.read')
    const res = typeof output === 'object' && output ? output as { stdout?: unknown; interrupted?: unknown; backgroundTaskId?: unknown } : undefined
    // Interrupted, or still running in the background: it has not finished.
    // The command may already have printed project text, so file.read stays.
    if (res?.interrupted === true || res?.backgroundTaskId) {
      if (res?.backgroundTaskId) shellTouched.set(String(res.backgroundTaskId), touched)
      return out.has('file.read') ? ['file.read'] : []
    }
    const stdout = typeof output === 'string' ? output : typeof res?.stdout === 'string' ? res.stdout : undefined
    for (const seg of certainSegments(cmd, stdout)) {
      const w = words(seg)
      if (starts(w, MAIL_READ)) out.add('mail.read')
      if (starts(w, MAIL_DRAFT)) out.add('mail.drafted')
      if (starts(w, CALENDAR_READ)) out.add('calendar.read')
      // curl or wget fetching an address, not `curl --version`.
      if (starts(w, WEB_COMMANDS) && /https?:\/\//i.test(cmd) && w.slice(1).some((x) => !x.startsWith('-'))) out.add('web.read')
    }
  }
  // Reading any source counts for a briefing.
  if (out.has('mail.read') || out.has('calendar.read') || out.has('web.read')) out.add('source.read')
  return [...out]
}

// --- the runs in flight -------------------------------------------------------

const active = new Map<string, AuthorityFacet>()

export type TrackedRun = {
  runKey: string
  authority: AuthorityFacet
  /** True when the run was opened before (a resume after a restart, a retry). */
  restored: boolean
  /** Stop collecting evidence for this run in this process. */
  end(): void
}

/** Open (or reopen) a run's obligations and start collecting its evidence. */
export function trackRun(runKey: string, obligations: Obligation[]): TrackedRun {
  // A one-shot keeps its key (job:<id>) for life. A run under it that was
  // closed (cancelled, failed, swept as unknown) is over; a resume after
  // /schedule resume is a new run and starts from nothing. An open one (a
  // restart mid-run, an overload retry) carries on with what it proved.
  if (loadRunState(runKey)?.terminal) dropRunState(runKey)
  const { authority, restored } = openRun(runKey, obligations)
  active.set(runKey, authority)
  return { runKey, authority, restored, end: () => { if (active.get(runKey) === authority) active.delete(runKey) } }
}

/**
 * A tool call succeeded: record what it shows against the current run. Called
 * by both runtimes after the tool returns, never by the model. Outside a
 * tracked run (chat, the owner at a terminal) it does nothing. Never throws:
 * evidence is bookkeeping and must not break a tool call.
 */
export function recordToolEvidence(callId: string, tool: string, input: unknown, output?: unknown, runKey: string | undefined = currentRun(), cwd?: string): number {
  // What the turn read, for its memory's provenance (card #235). Any turn, tracked or not.
  try { noteReads(evidenceTypes(tool, input, output, cwd)) } catch { /* never break the tool path */ }
  if (!runKey || !callId) return 0
  const authority = active.get(runKey)
  if (!authority) return 0
  let accepted = 0
  try {
    const types = evidenceTypes(tool, input, output, cwd)
    for (const o of authority.snapshot().obligations) {
      if (!types.includes(o.evidenceType)) continue
      const r = authority.record({ eventId: `${callId}:${o.id}`, runId: runKey, origin: 'tool', evidenceType: o.evidenceType, obligationId: o.id })
      if (r.accepted) accepted++
    }
  } catch { /* never break the tool path */ }
  return accepted
}

/** The run produced its answer: the harness's own evidence, once per run. */
export function recordFinished(run: TrackedRun): void {
  run.authority.record({ eventId: `${run.runKey}:finished`, runId: run.runKey, origin: 'app', evidenceType: FINISHED.evidenceType, obligationId: FINISHED.id })
}

/** A line for the prompt, so the job knows what it will be checked on. */
export function obligationNote(obligations: Obligation[]): string {
  const own = obligations.filter((o) => o.id !== FINISHED.id)
  if (!own.length) return ''
  return `\n\n(After this job, the assistant checks from its own records that it did these: ${own.map((o) => o.description).join('; ')}. If you could not, say so plainly in your answer.)`
}

/** What the owner is told when a run did not read as complete. Exported for tests. */
export function verdictNote(verdict: Verdict, obligations: readonly Obligation[]): string | null {
  if (verdict.status === 'complete') return null
  if (verdict.status === 'incomplete') {
    const missing = verdict.unmet.map((u) => obligations.find((o) => o.id === u.id)?.description ?? u.id)
    return `Not finished: there is no record that this job did the following: ${missing.join('; ')}. Its answer is below, but do not rely on it.`
  }
  if (verdict.status === 'unknown') return `I can't confirm this job finished (${verdict.reason ?? 'no record'}). Its answer is below, but check it before relying on it.`
  return null
}

/** For tests: forget every run in flight. */
export function resetTrackedRuns(): void {
  active.clear()
}
