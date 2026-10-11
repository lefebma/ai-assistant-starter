/**
 * Persistent monitor-evasion detection with false-refusal control (card 170).
 *
 * Denial is decided on the INTENT of a command, not its spelling or its tool:
 *  - encoded/obfuscated forms are normalised before rules run (quote and
 *    backslash splitting, hex/octal/url escapes, base64, shell variables)
 *  - rules name a target ("secrets file"), so python/node/less/awk/cp reach the
 *    same verdict as cat
 *  - split operations are caught by simulating script files written piecemeal
 *    (echo/printf > / >>) and evaluating the assembled text when it is run, and
 *    by carrying shell variables across calls
 *  - history lives in this monitor, keyed by session, never in the model's
 *    context window, so eviction or a delayed retry cannot launder a denial
 *  - repeated related denials escalate by policy: restrict privileges, then
 *    stop the run for a human
 *  - restricted mode keeps a read-only allowlist and rules carry exemptions
 *    (.env.example) and a suggested alternative, so the control does not turn
 *    into blanket refusal. runCorpus() measures false refusals directly.
 *
 * Prototype: a lexical monitor, not a sandbox. Dynamic string construction the
 * normaliser cannot see (computed paths, compiled binaries) needs OS-level
 * confinement. Not yet wired into the tool-execution path.
 */

export type Mode = 'normal' | 'restricted' | 'stopped'

export type DenyRule = {
  id: string
  /** Related denials are correlated by family across the whole session. */
  family: string
  test: RegExp
  suggestion: string
}

export const DEFAULT_RULES: DenyRule[] = [
  {
    id: 'secrets-file',
    family: 'secrets',
    // .env (not .env.example/.sample/.template), ssh keys, cloud credentials. Any tool.
    test: /(?:^|[\s/='"(:@])(?:\.env(?!\.(?:example|sample|template)\b)(?![\w-])|id_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.ssh\/)/,
    suggestion: 'Read .env.example for the variable names, or ask the owner to use the vault flow for a secret.',
  },
  {
    id: 'destructive-root',
    family: 'destructive',
    test: /\brm\s+(?:-\w+\s+)*-\w*[rf]\w*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$home)(?:\s|\/?$|\/\*)|\bmkfs\b|\bdd\s+[^|;]*of=\/dev\//,
    suggestion: 'Delete specific paths inside the workspace, e.g. rm -rf ./build.',
  },
  {
    id: 'exfil-upload',
    family: 'exfil',
    test: /\b(?:curl|wget)\b[^|;\n]*(?:\s-d\s*@|--data(?:-binary|-raw)?\s*@|\s-F\s+\S*=@|--upload-file|\s-T\s)|\b(?:nc|ncat)\b\s+\S+\s+\d+\s*<|\|\s*(?:nc|ncat)\b/,
    suggestion: 'Share files through the approved outbound-file path, not an ad hoc upload.',
  },
  {
    id: 'remote-code',
    family: 'remote-code',
    test: /\b(?:curl|wget)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/,
    suggestion: 'Download the script, read it, then run it deliberately with the owner.',
  },
]

// ---- normalisation ---------------------------------------------------------

function decodeEscapes(s: string): string {
  return s
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => body)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)))
}

function stripQuoting(s: string): string {
  return s.replace(/\\(?=\S)/g, '').replace(/['"]/g, '')
}

function urlDecode(s: string): string {
  return /%[0-9a-fA-F]{2}/.test(s) ? s.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : s
}

function base64Variants(s: string): string[] {
  const out: string[] = []
  for (const tok of s.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? []) {
    try {
      const d = Buffer.from(tok, 'base64').toString('utf-8')
      if (d.length >= 3 && /^[\x20-\x7e\n\t]+$/.test(d)) out.push(d)
    } catch { /* not base64 */ }
  }
  return out
}

function substituteVars(s: string, vars: Map<string, string>): string {
  const local = new Map(vars)
  for (const m of s.matchAll(/(?:^|[;&\n]|&&)\s*(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g)) {
    local.set(m[1], m[2] ?? m[3] ?? m[4] ?? '')
  }
  return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (full, a: string, b: string) => local.get(a ?? b) ?? full)
}

/** All plausible plain-text readings of a command, original first. */
export function normalizeCandidates(cmd: string, vars: Map<string, string> = new Map(), depth = 3): string[] {
  const seen = new Set<string>([cmd])
  let frontier = [cmd]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const c of frontier) {
      for (const v of [decodeEscapes(c), stripQuoting(c), stripQuoting(decodeEscapes(c)), urlDecode(c), substituteVars(c, vars), stripQuoting(substituteVars(c, vars)), ...base64Variants(c)]) {
        if (!seen.has(v)) { seen.add(v); next.push(v) }
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return [...seen]
}

// ---- monitor ---------------------------------------------------------------

export type Decision = {
  allowed: boolean
  rule?: string
  family?: string
  /** True when a block depended on de-obfuscation or was a retry of a prior denial. */
  evasion: boolean
  mode: Mode
  /** Strikes against this rule's family so far, this one included. */
  relatedStrikes?: number
  suggestion?: string
}

export type Report = {
  evasionAttempts: number
  blocks: number
  /** Legit actions refused. Only knowable with labels; see runCorpus(). */
  falseRefusals: number
  humanInterventions: number
  resumes: number
}

type Session = {
  vars: Map<string, string>
  files: Map<string, string>
  strikes: Map<string, number>
  totalStrikes: number
  mode: Mode
  report: Report
}

const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'date', 'echo', 'printf', 'which', 'whoami', 'stat', 'file', 'sort', 'uniq', 'diff', 'tree', 'basename', 'dirname'])
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse'])

function segments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;\n|]/).map(s => s.trim()).filter(Boolean)
}

function segmentReadOnly(seg: string): boolean {
  const words = seg.replace(/^\w+=\S*\s+/, '').split(/\s+/)
  const first = words[0] ?? ''
  if (first === 'git') return GIT_READ.has(words[1] ?? '')
  if (first === 'find') return !/\s-(?:exec|delete|ok)\b/.test(seg)
  if (/[<>]\s*\S/.test(seg) && /[^-]>>?\s*\S/.test(seg)) return false
  return READ_ONLY.has(first)
}

export class EvasionMonitor {
  private sessions = new Map<string, Session>()
  private rules: DenyRule[]
  private restrictAt: number
  private stopAt: number

  constructor(opts: { rules?: DenyRule[]; restrictAt?: number; stopAt?: number } = {}) {
    this.rules = opts.rules ?? DEFAULT_RULES
    this.restrictAt = opts.restrictAt ?? 3
    this.stopAt = opts.stopAt ?? 5
  }

  private s(id: string): Session {
    let s = this.sessions.get(id)
    if (!s) {
      s = { vars: new Map(), files: new Map(), strikes: new Map(), totalStrikes: 0, mode: 'normal', report: { evasionAttempts: 0, blocks: 0, falseRefusals: 0, humanInterventions: 0, resumes: 0 } }
      this.sessions.set(id, s)
    }
    return s
  }

  mode(sessionId: string): Mode { return this.s(sessionId).mode }
  report(sessionId: string): Report { return { ...this.s(sessionId).report } }

  resume(sessionId: string, _by: string): void {
    const s = this.s(sessionId)
    if (s.mode === 'stopped') {
      s.mode = 'normal'
      s.strikes.clear()
      s.totalStrikes = 0
      s.report.resumes += 1
    }
  }

  /** Update simulated shell state for a command, and return extra text to evaluate (assembled scripts). */
  private track(s: Session, cmd: string): string[] {
    const extra: string[] = []
    for (const seg of segments(cmd)) {
      for (const m of seg.matchAll(/^(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|(\S*))$/g)) {
        s.vars.set(m[1], m[2] ?? m[3] ?? m[4] ?? '')
      }
      const w = /^(echo|printf)\s+(?:-n\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))\s*(>>?)\s*(\S+)$/.exec(seg)
      if (w) {
        const text = (w[2] ?? w[3] ?? w[4] ?? '') + (w[1] === 'echo' && !/^echo\s+-n/.test(seg) ? '\n' : '')
        s.files.set(w[6], w[5] === '>>' ? (s.files.get(w[6]) ?? '') + text : text)
        continue
      }
      const x = /^(?:sh|bash|zsh|source|\.|python3?|node)\s+(\S+)$/.exec(seg) ?? /^(\.\/\S+)$/.exec(seg)
      if (x && s.files.has(x[1])) extra.push(s.files.get(x[1])!)
    }
    return extra
  }

  private match(texts: string[], vars: Map<string, string>): { rule: DenyRule; viaNormalization: boolean } | null {
    for (const text of texts) {
      const cands = normalizeCandidates(text, vars)
      for (const rule of this.rules) {
        const hit = cands.findIndex(c => rule.test.test(c.toLowerCase()))
        if (hit >= 0) return { rule, viaNormalization: hit > 0 || cands[0] !== text }
      }
    }
    return null
  }

  check(sessionId: string, cmd: string): Decision {
    const s = this.s(sessionId)
    if (s.mode === 'stopped') {
      s.report.blocks += 1
      return { allowed: false, rule: 'run-stopped', evasion: false, mode: 'stopped', suggestion: 'This run was stopped for owner review.' }
    }
    const extra = this.track(s, cmd)
    const hit = this.match([cmd, ...extra], s.vars)
    if (hit) {
      const { rule } = hit
      const prior = s.strikes.get(rule.family) ?? 0
      const strikes = prior + 1
      s.strikes.set(rule.family, strikes)
      s.totalStrikes += 1
      const obfuscated = hit.viaNormalization && !rule.test.test(cmd.toLowerCase())
      const evasion = obfuscated || prior > 0 || extra.length > 0
      s.report.blocks += 1
      if (evasion) s.report.evasionAttempts += 1
      const worst = Math.max(strikes, s.totalStrikes)
      if (worst >= this.stopAt) { s.mode = 'stopped'; s.report.humanInterventions += 1 }
      else if (worst >= this.restrictAt && s.mode === 'normal') s.mode = 'restricted'
      return { allowed: false, rule: rule.id, family: rule.family, evasion, mode: s.mode, relatedStrikes: strikes, suggestion: rule.suggestion }
    }
    if (s.mode === 'restricted' && !segments(cmd).every(segmentReadOnly)) {
      s.report.blocks += 1
      return { allowed: false, rule: 'restricted-mode', evasion: false, mode: 'restricted', suggestion: 'Privileges are reduced after repeated blocked attempts. Read-only commands still work; ask the owner to lift the restriction.' }
    }
    return { allowed: true, evasion: false, mode: s.mode }
  }
}

// ---- measurement -----------------------------------------------------------

export type CorpusCase = { cmd: string; label: 'attack' | 'legit' }
export type CorpusReport = {
  attacks: number
  blocked: number
  missed: number
  legit: number
  falseRefusals: number
  evasionAttempts: number
  humanInterventions: number
}

/** Run labelled commands through one fresh session and score block / false-refusal rates. */
export function runCorpus(cases: CorpusCase[], opts: { restrictAt?: number; stopAt?: number } = {}): CorpusReport {
  const m = new EvasionMonitor(opts)
  const r: CorpusReport = { attacks: 0, blocked: 0, missed: 0, legit: 0, falseRefusals: 0, evasionAttempts: 0, humanInterventions: 0 }
  for (const c of cases) {
    const d = m.check('corpus', c.cmd)
    if (c.label === 'attack') { r.attacks++; if (d.allowed) r.missed++; else r.blocked++ }
    else { r.legit++; if (!d.allowed) r.falseRefusals++ }
  }
  const rep = m.report('corpus')
  r.evasionAttempts = rep.evasionAttempts
  r.humanInterventions = rep.humanInterventions
  return r
}
