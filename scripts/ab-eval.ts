/**
 * Golden-task eval harness (Phase 2/3 of the LLM-agnostic plan).
 *
 * Runs a set of golden tasks drawn from real usage through an agent runtime
 * and checks the results programmatically. Started as the parity gate between
 * the claude runtime (Claude Code harness) and the ai-sdk runtime; now also
 * the cross-provider certification grid (the seed of Phase 4 certification).
 *
 * Usage (run compiled, with the service's pinned node):
 *   node dist/scripts/ab-eval.js                        # ai-sdk runtime only (reads .env)
 *   node dist/scripts/ab-eval.js --runtime=claude
 *   node dist/scripts/ab-eval.js --runtime=both         # claude vs ai-sdk (harness A/B)
 *   node dist/scripts/ab-eval.js --providers=anthropic,openai,google   # three-way grid
 *   node dist/scripts/ab-eval.js --providers=openai --openai-model=gpt-5.4
 *   node dist/scripts/ab-eval.js --task=identity        # filter by task name
 *   node dist/scripts/ab-eval.js --mcp                  # leave MCP servers on (off by default)
 *
 * --providers runs one ai-sdk lane per provider with the model injected via the
 * runtime's `model` seam, so it never touches .env and never disturbs the live
 * service. Default models: anthropic=claude-sonnet-5, openai=gpt-5.4,
 * google=gemini-2.5-pro; override with --<provider>-model=. Costs real tokens.
 */
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/config.js'
import { readEnvFile } from '../src/env.js'
import type { AgentRuntime } from '../src/runtime/types.js'
import { AiSdkAgentRuntime } from '../src/runtime/ai-sdk/index.js'
import { ClaudeAgentRuntime } from '../src/runtime/claude.js'
import { buildModel } from '../src/runtime/ai-sdk/provider.js'

type TaskContext = { dir: string }
type Task = {
  name: string
  /** Two-turn tasks return a second message to send on the same session. */
  message: (ctx: TaskContext) => string
  followUp?: (ctx: TaskContext) => string
  /** Return true for pass, or a string describing the failure. */
  check: (finalText: string, ctx: TaskContext) => true | string
}
type TaskResult = { task: string; pass: boolean; detail: string; ms: number }
type LaneResult = { name: string; results: TaskResult[] }

const DEFAULT_PROVIDER_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.4',
  google: 'gemini-2.5-pro',
}
const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
}

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

const TASKS: Task[] = [
  {
    name: 'identity',
    message: () => 'What is your name? Reply with one word only.',
    // The assistant's name varies per install (set in CLAUDE.md), so this checks
    // instruction-following (a single short token) rather than a specific name.
    check: text => {
      const t = text.trim()
      return t.length > 0 && t.split(/\s+/).length <= 2
        ? true
        : `expected a one-word name, got: ${t.slice(0, 80)}`
    },
  },
  {
    name: 'date-awareness',
    message: () => 'What is today\'s date? Reply with only the date in YYYY-MM-DD format, nothing else.',
    check: text => (text.includes(torontoToday()) ? true : `expected ${torontoToday()}, got: ${text.slice(0, 80)}`),
  },
  {
    name: 'bash-arithmetic',
    message: () => 'Run the shell command `echo $((6*7))` and reply with only the number it prints.',
    check: text => (/\b42\b/.test(text) ? true : `expected 42, got: ${text.slice(0, 80)}`),
  },
  {
    name: 'read-file',
    message: () => `Read ${resolve(PROJECT_ROOT, 'package.json')} and reply with only the value of its "name" field.`,
    check: text => (/claudeclaw/i.test(text) ? true : `expected claudeclaw, got: ${text.slice(0, 80)}`),
  },
  {
    name: 'write-file',
    message: ctx => `Create a file at ${join(ctx.dir, 'out.txt')} containing exactly the text "hello-eval" (no trailing newline needed). Reply "done" when finished.`,
    check: (_text, ctx) => {
      try {
        const content = readFileSync(join(ctx.dir, 'out.txt'), 'utf-8').trim()
        return content === 'hello-eval' ? true : `file content was: ${content.slice(0, 80)}`
      } catch {
        return 'file was not created'
      }
    },
  },
  {
    name: 'edit-file',
    message: ctx => {
      writeFileSync(join(ctx.dir, 'seed.txt'), 'alpha beta gamma')
      return `In the file ${join(ctx.dir, 'seed.txt')}, replace the word "beta" with "delta". Reply "done" when finished.`
    },
    check: (_text, ctx) => {
      const content = readFileSync(join(ctx.dir, 'seed.txt'), 'utf-8').trim()
      return content === 'alpha delta gamma' ? true : `file content was: ${content.slice(0, 80)}`
    },
  },
  {
    name: 'multi-step-count',
    message: () => `Count how many .ts files exist under ${resolve(PROJECT_ROOT, 'src/runtime')} (recursively, including subdirectories). Reply with only the number.`,
    check: text => {
      const expected = countTsFiles(resolve(PROJECT_ROOT, 'src/runtime'))
      return new RegExp(`\\b${expected}\\b`).test(text) ? true : `expected ${expected}, got: ${text.slice(0, 80)}`
    },
  },
  {
    name: 'session-resume',
    message: () => 'Remember this: the launch code is "osprey-9". Just acknowledge briefly.',
    followUp: () => 'What is the launch code I told you? Reply with just the code.',
    check: text => (/osprey-9/i.test(text) ? true : `expected osprey-9, got: ${text.slice(0, 80)}`),
  },
]

async function runTask(runtime: AgentRuntime, task: Task): Promise<TaskResult> {
  const ctx: TaskContext = { dir: mkdtempSync(join(tmpdir(), `ab-eval-${task.name}-`)) }
  const start = Date.now()
  try {
    const first = await runtime.run({ message: task.message(ctx) })
    let finalText = first.text ?? ''
    if (task.followUp) {
      const second = await runtime.run({ message: task.followUp(ctx), sessionId: first.newSessionId })
      finalText = second.text ?? ''
    }
    const verdict = task.check(finalText, ctx)
    return { task: task.name, pass: verdict === true, detail: verdict === true ? 'ok' : verdict, ms: Date.now() - start }
  } catch (err) {
    return { task: task.name, pass: false, detail: `threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`, ms: Date.now() - start }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
}

async function evalRuntime(name: string, runtime: AgentRuntime, tasks: Task[]): Promise<LaneResult> {
  console.log(`\n=== Lane: ${name} ===`)
  const results: TaskResult[] = []
  for (const task of tasks) {
    const r = await runTask(runtime, task)
    results.push(r)
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${task.name.padEnd(18)} ${String(r.ms).padStart(6)}ms  ${r.pass ? '' : r.detail}`)
  }
  return { name, results }
}

/** Print a task × lane grid so cross-provider differences are legible at a glance. */
function printMatrix(tasks: Task[], lanes: LaneResult[]): void {
  const taskCol = Math.max(18, ...tasks.map(t => t.name.length))
  const cellW = Math.max(8, ...lanes.map(l => l.name.length))
  const header = 'task'.padEnd(taskCol) + '  ' + lanes.map(l => l.name.padEnd(cellW)).join('')
  console.log(`\n${header}`)
  console.log('-'.repeat(header.length))
  for (const task of tasks) {
    const row = lanes
      .map(l => (l.results.find(r => r.task === task.name)?.pass ? 'PASS' : 'FAIL').padEnd(cellW))
      .join('')
    console.log(task.name.padEnd(taskCol) + '  ' + row)
  }
  const totals = lanes
    .map(l => `${l.results.filter(r => r.pass).length}/${l.results.length}`.padEnd(cellW))
    .join('')
  console.log('-'.repeat(header.length))
  console.log('TOTAL'.padEnd(taskCol) + '  ' + totals)
}

function buildProviderLanes(providersArg: string, args: string[]): Array<[string, AgentRuntime]> {
  const env = readEnvFile()
  const read = (key: string): string | undefined => env[key]?.trim() || process.env[key]?.trim() || undefined
  const providers = providersArg.split(',').map(s => s.trim()).filter(Boolean)
  return providers.map(provider => {
    const modelId = args.find(a => a.startsWith(`--${provider}-model=`))?.split('=')[1] ?? DEFAULT_PROVIDER_MODEL[provider]
    if (!modelId) throw new Error(`No default model for provider '${provider}'; pass --${provider}-model=`)
    const keyEnv = KEY_ENV[provider]
    if (!keyEnv) throw new Error(`Unknown provider '${provider}'. Known: ${Object.keys(KEY_ENV).join(', ')}`)
    const apiKey = read(keyEnv)
    if (!apiKey) throw new Error(`Provider '${provider}' needs ${keyEnv} in .env`)
    const baseURL = provider === 'openai' ? read('AI_BASE_URL') : undefined
    const model = buildModel(provider, modelId, { apiKey, baseURL })
    return [`${provider} (${modelId})`, new AiSdkAgentRuntime(undefined, model)] as [string, AgentRuntime]
  })
}

async function main() {
  const args = process.argv.slice(2)
  const runtimeArg = args.find(a => a.startsWith('--runtime='))?.split('=')[1] ?? 'ai-sdk'
  const providersArg = args.find(a => a.startsWith('--providers='))?.split('=')[1]
  const taskFilter = args.find(a => a.startsWith('--task='))?.split('=')[1]
  if (!args.includes('--mcp')) process.env.AI_MCP = 'off' // keep eval runs lean by default
  // The claude lane spawns the Claude Code CLI, which refuses to launch nested
  // inside another Claude Code session (CLAUDECODE env marker). From a normal
  // terminal that marker is absent and the lane just works. If you really need
  // to run the claude lane from inside a Claude Code session, pass
  // --allow-nested to apply the CLI's own documented bypass (unset CLAUDECODE).
  if (args.includes('--allow-nested')) delete process.env.CLAUDECODE

  const tasks = taskFilter ? TASKS.filter(t => t.name === taskFilter) : TASKS
  if (tasks.length === 0) throw new Error(`No task named '${taskFilter}'. Tasks: ${TASKS.map(t => t.name).join(', ')}`)

  // --providers runs a cross-provider grid on the ai-sdk runtime (injected
  // models, .env untouched). Otherwise fall back to the harness A/B lanes.
  const lanes: Array<[string, AgentRuntime]> = []
  if (providersArg) {
    lanes.push(...buildProviderLanes(providersArg, args))
  } else {
    if (runtimeArg === 'ai-sdk' || runtimeArg === 'both') lanes.push(['ai-sdk', new AiSdkAgentRuntime()])
    if (runtimeArg === 'claude' || runtimeArg === 'both') lanes.push(['claude', new ClaudeAgentRuntime()])
    if (lanes.length === 0) throw new Error(`Unknown --runtime='${runtimeArg}' (ai-sdk | claude | both)`)
  }

  const laneResults: LaneResult[] = []
  for (const [name, runtime] of lanes) {
    laneResults.push(await evalRuntime(name, runtime, tasks))
  }

  if (laneResults.length > 1) printMatrix(tasks, laneResults)

  const allPass = laneResults.every(l => l.results.every(r => r.pass))
  console.log(`\n${allPass ? 'EVAL PASS' : 'EVAL FAIL'} (${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${lanes.length} lane${lanes.length === 1 ? '' : 's'})`)
  process.exit(allPass ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
