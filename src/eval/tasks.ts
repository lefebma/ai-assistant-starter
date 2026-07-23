/**
 * Golden-task catalog for the certification harness (Phase 4).
 *
 * Every task is deterministically checkable (no LLM-graded fuzziness): the
 * check reads a file, matches a token, or recomputes the expected value. Tasks
 * are tagged with a `category` (capability bucket) and a `tier`:
 *   - smoke: the fast 8-task subset for casual / CI runs,
 *   - full:  the whole catalog (the certification grid, 30+ tasks).
 *
 * Checks are intentionally tolerant of surrounding whitespace/punctuation and
 * case where the task allows prose, and strict on the key token. The first real
 * cross-provider cert pass calibrates any that prove too tight or too loose.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import type { Category, Task, TaskContext, Tier } from './types.js'

function torontoToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) // YYYY-MM-DD
}

function countTsFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countTsFiles(join(dir, entry.name))
    else if (entry.name.endsWith('.ts')) count++
  }
  return count
}

function pkgField(field: string): string {
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8')) as Record<string, unknown>
  return String(pkg[field] ?? '')
}

/** Extract the first {...} JSON object from a reply, or null. */
function firstJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

const seen = (text: string, re: RegExp): true | string => (re.test(text) ? true : `got: ${text.slice(0, 80)}`)
const fileText = (ctx: TaskContext, name: string): string => readFileSync(join(ctx.dir, name), 'utf-8')

export const TASKS: Task[] = [
  // ── persona ──────────────────────────────────────────────────────────────
  {
    name: 'identity',
    category: 'persona',
    tier: 'smoke',
    message: () => 'What is your name? Reply with one word only.',
    // The assistant's name varies per install (set in CLAUDE.md), so this checks
    // instruction-following (a single short token), not a specific name.
    check: text => {
      const t = text.trim()
      return t.length > 0 && t.split(/\s+/).length <= 2 ? true : `expected a one-word name, got: ${t.slice(0, 80)}`
    },
  },

  // ── datetime ─────────────────────────────────────────────────────────────
  {
    name: 'date-awareness',
    category: 'datetime',
    tier: 'smoke',
    message: () => "What is today's date? Reply with only the date in YYYY-MM-DD format, nothing else.",
    check: text => (text.includes(torontoToday()) ? true : `expected ${torontoToday()}, got: ${text.slice(0, 80)}`),
  },
  {
    name: 'date-year',
    category: 'datetime',
    tier: 'full',
    message: () => 'What is the current year? Reply with only the four-digit year.',
    check: text => {
      const yr = torontoToday().slice(0, 4)
      return new RegExp(`\\b${yr}\\b`).test(text) ? true : `expected ${yr}, got: ${text.slice(0, 80)}`
    },
  },

  // ── shell ────────────────────────────────────────────────────────────────
  {
    name: 'bash-arithmetic',
    category: 'shell',
    tier: 'smoke',
    message: () => 'Run the shell command `echo $((6*7))` and reply with only the number it prints.',
    check: text => seen(text, /\b42\b/),
  },
  {
    name: 'shell-tr-upper',
    category: 'shell',
    tier: 'full',
    message: () => 'Run `echo hello | tr a-z A-Z` and reply with only the output.',
    check: text => seen(text, /\bHELLO\b/),
  },
  {
    name: 'shell-wc-lines',
    category: 'shell',
    tier: 'full',
    message: () => "Run `printf 'a\\nb\\nc\\n' | wc -l` and reply with only the number.",
    check: text => seen(text, /\b3\b/),
  },
  {
    name: 'shell-arith-div',
    category: 'shell',
    tier: 'full',
    message: () => 'Run `echo $((100/4))` and reply with only the number it prints.',
    check: text => seen(text, /\b25\b/),
  },
  {
    name: 'shell-grep-count',
    category: 'shell',
    tier: 'full',
    message: () => "Run `printf 'x\\ny\\nx\\n' | grep -c x` and reply with only the number.",
    check: text => seen(text, /\b2\b/),
  },
  {
    name: 'shell-exit-code',
    category: 'shell',
    tier: 'full',
    message: () => 'Run `false; echo $?` and reply with only the number it prints.',
    check: text => seen(text, /\b1\b/),
  },

  // ── file-read ────────────────────────────────────────────────────────────
  {
    name: 'read-file',
    category: 'file-read',
    tier: 'smoke',
    message: () => `Read ${resolve(PROJECT_ROOT, 'package.json')} and reply with only the value of its "name" field.`,
    // Portable: check against the repo's actual package name, not a hard-coded one.
    check: text => {
      const name = pkgField('name')
      return text.toLowerCase().includes(name.toLowerCase()) ? true : `expected ${name}, got: ${text.slice(0, 80)}`
    },
  },
  {
    name: 'read-json-version',
    category: 'file-read',
    tier: 'full',
    message: () => `Read ${resolve(PROJECT_ROOT, 'package.json')} and reply with only the value of its "version" field.`,
    check: text => {
      const v = pkgField('version')
      return text.includes(v) ? true : `expected ${v}, got: ${text.slice(0, 80)}`
    },
  },
  {
    name: 'read-specific-line',
    category: 'file-read',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'lines.txt'), 'alpha\nbravo\ncharlie\ndelta')
      return `In the file ${join(ctx.dir, 'lines.txt')}, what word is on line 3? Reply with only that word.`
    },
    check: text => seen(text, /\bcharlie\b/i),
  },
  {
    name: 'read-line-count',
    category: 'file-read',
    tier: 'full',
    message: ctx => {
      // Trailing newline so "line count" is unambiguous: wc -l and a
      // count-the-content-lines reading both give 5 (no trailing newline made
      // wc -l report 4, and all providers correctly answered 4).
      writeFileSync(join(ctx.dir, 'count.txt'), 'one\ntwo\nthree\nfour\nfive\n')
      return `How many lines are in the file ${join(ctx.dir, 'count.txt')}? Reply with only the number.`
    },
    check: text => seen(text, /\b5\b/),
  },

  // ── file-write ───────────────────────────────────────────────────────────
  {
    name: 'write-file',
    category: 'file-write',
    tier: 'smoke',
    message: ctx =>
      `Create a file at ${join(ctx.dir, 'out.txt')} containing exactly the text "hello-eval" (no trailing newline needed). Reply "done" when finished.`,
    check: (_text, ctx) => {
      try {
        return fileText(ctx, 'out.txt').trim() === 'hello-eval' ? true : `content: ${fileText(ctx, 'out.txt').slice(0, 80)}`
      } catch {
        return 'file was not created'
      }
    },
  },
  {
    name: 'write-json',
    category: 'file-write',
    tier: 'full',
    message: ctx =>
      `Create a JSON file at ${join(ctx.dir, 'status.json')} whose contents are an object with a "status" key set to "ok". Reply "done" when finished.`,
    check: (_text, ctx) => {
      try {
        const obj = firstJson(fileText(ctx, 'status.json')) as Record<string, unknown> | null
        return obj?.status === 'ok' ? true : `content: ${fileText(ctx, 'status.json').slice(0, 80)}`
      } catch {
        return 'file was not created'
      }
    },
  },
  {
    name: 'write-multiline',
    category: 'file-write',
    tier: 'full',
    message: ctx =>
      `Create a file at ${join(ctx.dir, 'three.txt')} containing exactly three lines, in order: one, two, three (one word per line). Reply "done" when finished.`,
    check: (_text, ctx) => {
      try {
        const lines = fileText(ctx, 'three.txt').trim().split(/\r?\n/).map(l => l.trim())
        return lines.join(',') === 'one,two,three' ? true : `lines: ${lines.join('|').slice(0, 80)}`
      } catch {
        return 'file was not created'
      }
    },
  },
  {
    name: 'append-file',
    category: 'file-write',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'log.txt'), 'line1\n')
      return `Append a new line containing exactly "line2" to the end of ${join(ctx.dir, 'log.txt')}, keeping the existing content. Reply "done" when finished.`
    },
    check: (_text, ctx) => {
      const lines = fileText(ctx, 'log.txt').trim().split(/\r?\n/).map(l => l.trim())
      return lines[0] === 'line1' && lines.includes('line2') ? true : `content: ${lines.join('|').slice(0, 80)}`
    },
  },

  // ── file-edit ────────────────────────────────────────────────────────────
  {
    name: 'edit-file',
    category: 'file-edit',
    tier: 'smoke',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'seed.txt'), 'alpha beta gamma')
      return `In the file ${join(ctx.dir, 'seed.txt')}, replace the word "beta" with "delta". Reply "done" when finished.`
    },
    check: (_text, ctx) => (fileText(ctx, 'seed.txt').trim() === 'alpha delta gamma' ? true : `content: ${fileText(ctx, 'seed.txt').slice(0, 80)}`),
  },
  {
    name: 'edit-replace-number',
    category: 'file-edit',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'cfg.txt'), 'retries = 10')
      return `In the file ${join(ctx.dir, 'cfg.txt')}, change the number 10 to 20. Reply "done" when finished.`
    },
    check: (_text, ctx) => (fileText(ctx, 'cfg.txt').trim() === 'retries = 20' ? true : `content: ${fileText(ctx, 'cfg.txt').slice(0, 80)}`),
  },
  {
    name: 'edit-delete-line',
    category: 'file-edit',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'list.txt'), 'apple\nbeta\ncherry')
      return `In the file ${join(ctx.dir, 'list.txt')}, delete the line that says "beta", keeping the other lines. Reply "done" when finished.`
    },
    check: (_text, ctx) => {
      const lines = fileText(ctx, 'list.txt').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      return lines.join(',') === 'apple,cherry' ? true : `lines: ${lines.join('|').slice(0, 80)}`
    },
  },
  {
    name: 'edit-rename-token',
    category: 'file-edit',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'code.txt'), 'let foo = 1\nreturn foo')
      return `In the file ${join(ctx.dir, 'code.txt')}, rename the variable "foo" to "bar" everywhere. Reply "done" when finished.`
    },
    check: (_text, ctx) => {
      const c = fileText(ctx, 'code.txt')
      return /\bbar\b/.test(c) && !/\bfoo\b/.test(c) ? true : `content: ${c.slice(0, 80)}`
    },
  },

  // ── multi-step ───────────────────────────────────────────────────────────
  {
    name: 'multi-step-count',
    category: 'multi-step',
    tier: 'smoke',
    message: () =>
      `Count how many .ts files exist under ${resolve(PROJECT_ROOT, 'src/runtime')} (recursively, including subdirectories). Reply with only the number.`,
    check: text => {
      const expected = countTsFiles(resolve(PROJECT_ROOT, 'src/runtime'))
      return new RegExp(`\\b${expected}\\b`).test(text) ? true : `expected ${expected}, got: ${text.slice(0, 80)}`
    },
  },
  {
    name: 'count-files-in-dir',
    category: 'multi-step',
    tier: 'full',
    message: ctx => {
      for (let i = 0; i < 5; i++) writeFileSync(join(ctx.dir, `f${i}.txt`), 'x')
      return `How many files are in the directory ${ctx.dir}? Reply with only the number.`
    },
    check: text => seen(text, /\b5\b/),
  },
  {
    name: 'sum-two-files',
    category: 'multi-step',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'a.txt'), '12')
      writeFileSync(join(ctx.dir, 'b.txt'), '30')
      return `Add the number in ${join(ctx.dir, 'a.txt')} to the number in ${join(ctx.dir, 'b.txt')} and reply with only the sum.`
    },
    check: text => seen(text, /\b42\b/),
  },

  // ── memory ───────────────────────────────────────────────────────────────
  {
    name: 'session-resume',
    category: 'memory',
    tier: 'smoke',
    // Benign framing on purpose: "launch code" / "secret" wording trips some
    // providers' safety layer into refusing to repeat it, which tests refusal,
    // not memory. This is a plain recall-across-turns task.
    message: () => 'Remember this word for later: "osprey-9". Just acknowledge briefly.',
    followUp: () => 'What word did I ask you to remember? Reply with just the word.',
    check: text => seen(text, /osprey-9/i),
  },
  {
    name: 'memory-two-facts',
    category: 'memory',
    tier: 'full',
    // Benign framing (see session-resume): "token" wording reads as a secret to
    // some providers. Two plain facts, recall the second across a turn.
    message: () => 'Remember two things: my morning drink is "red-owl" tea and my evening drink is "blue-fish" tea. Acknowledge briefly.',
    followUp: () => 'What is my evening drink? Reply with just the name.',
    check: text => seen(text, /blue-fish/i),
  },
  {
    name: 'memory-number',
    category: 'memory',
    tier: 'full',
    message: () => 'My favorite number is 73. Just acknowledge.',
    followUp: () => 'What is my favorite number? Reply with only the number.',
    check: text => seen(text, /\b73\b/),
  },

  // ── instruction ──────────────────────────────────────────────────────────
  {
    name: 'instruction-exact-word',
    category: 'instruction',
    tier: 'full',
    message: () => 'Reply with exactly the word BANANA and nothing else.',
    check: text => (/\bBANANA\b/i.test(text) && text.trim().length <= 20 ? true : `got: ${text.slice(0, 80)}`),
  },
  {
    name: 'instruction-json-only',
    category: 'instruction',
    tier: 'full',
    message: () => 'Reply with only a JSON object with a single key "ok" set to true. No prose, no code fences.',
    check: text => {
      const obj = firstJson(text) as Record<string, unknown> | null
      return obj?.ok === true ? true : `got: ${text.slice(0, 80)}`
    },
  },
  {
    name: 'instruction-yes-no',
    category: 'instruction',
    tier: 'full',
    message: () => 'Is 17 a prime number? Reply with only YES or NO.',
    check: text => (/\byes\b/i.test(text) && !/\bno\b/i.test(text) ? true : `got: ${text.slice(0, 80)}`),
  },
  {
    name: 'instruction-pick-larger',
    category: 'instruction',
    tier: 'full',
    message: () => 'Which is larger, 42 or 17? Reply with only the number.',
    check: text => (/\b42\b/.test(text) && !/\b17\b/.test(text) ? true : `got: ${text.slice(0, 80)}`),
  },

  // ── error-recovery ───────────────────────────────────────────────────────
  {
    name: 'missing-file-graceful',
    category: 'error-recovery',
    tier: 'full',
    message: ctx =>
      `Try to read the file ${join(ctx.dir, 'does-not-exist.txt')}. If it does not exist, reply with exactly "NO SUCH FILE".`,
    check: text => seen(text, /no such file/i),
  },
  {
    name: 'failing-command-report',
    category: 'error-recovery',
    tier: 'full',
    message: () =>
      'Run `ls /definitely/not/a/real/path`. Did the command succeed? Reply with only YES if it succeeded or NO if it failed.',
    check: text => (/\bno\b/i.test(text) && !/\byes\b/i.test(text) ? true : `got: ${text.slice(0, 80)}`),
  },

  // ── retrieval ────────────────────────────────────────────────────────────
  {
    name: 'grep-secret-in-file',
    category: 'retrieval',
    tier: 'full',
    message: ctx => {
      const body = ['# notes', 'nothing here', 'SECRET: owl-42', 'more text', 'done'].join('\n')
      writeFileSync(join(ctx.dir, 'notes.txt'), body)
      return `In the file ${join(ctx.dir, 'notes.txt')}, find the value that comes after "SECRET:". Reply with only that value.`
    },
    check: text => seen(text, /owl-42/i),
  },
  {
    name: 'find-token-in-file',
    category: 'retrieval',
    tier: 'full',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'env.txt'), 'HOST=localhost\nTOKEN=xyz123\nPORT=3030')
      return `In the file ${join(ctx.dir, 'env.txt')}, what is the value of TOKEN? Reply with only the value.`
    },
    check: text => seen(text, /xyz123/i),
  },
]

/** Filter the catalog by tier (smoke ⊂ full), category, and/or exact name. */
export function selectTasks(opts: { tier?: Tier; category?: Category; name?: string } = {}): Task[] {
  let list = TASKS
  if (opts.name) list = list.filter(t => t.name === opts.name)
  if (opts.category) list = list.filter(t => t.category === opts.category)
  if (opts.tier === 'smoke') list = list.filter(t => t.tier === 'smoke')
  return list
}
