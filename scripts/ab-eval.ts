/**
 * Golden-task certification CLI (Phase 2/3/4 of the LLM-agnostic plan).
 *
 * Thin CLI over src/eval/*: it builds the lanes, runs the selected tasks, and
 * (optionally) persists the run and diffs it against the committed baseline.
 * All harness logic lives in src/eval/ and is unit-tested without a runtime;
 * this file only does argument parsing, lane construction, and presentation.
 *
 * Usage (run compiled, with the service's pinned node):
 *   node dist/scripts/ab-eval.js                        # ai-sdk runtime, smoke tier (reads .env)
 *   node dist/scripts/ab-eval.js --tier=full            # the full certification grid
 *   node dist/scripts/ab-eval.js --runtime=both         # claude vs ai-sdk (harness A/B)
 *   node dist/scripts/ab-eval.js --providers=anthropic,openai,google --tier=full   # cert grid
 *   node dist/scripts/ab-eval.js --providers=openai --openai-model=gpt-5.4
 *   node dist/scripts/ab-eval.js --task=identity        # one task by name
 *   node dist/scripts/ab-eval.js --category=shell       # one capability bucket
 *   node dist/scripts/ab-eval.js --tier=full --baseline # compare to certification/baseline.json
 *   node dist/scripts/ab-eval.js --tier=full --save     # also write a run to certification/runs/
 *   node dist/scripts/ab-eval.js --tier=full --update-baseline  # promote this run to the bar
 *   node dist/scripts/ab-eval.js --mcp                  # leave MCP servers on (off by default)
 *
 * --providers runs one ai-sdk lane per provider with the model injected via the
 * runtime's `model` seam, so it never touches .env and never disturbs the live
 * service. Default models: anthropic=claude-sonnet-5, openai=gpt-5.4,
 * google=gemini-2.5-pro; override with --<provider>-model=. Costs real tokens.
 */
import { readEnvFile } from '../src/env.js'
import type { AgentRuntime } from '../src/runtime/types.js'
import { AiSdkAgentRuntime } from '../src/runtime/ai-sdk/index.js'
import { ClaudeAgentRuntime } from '../src/runtime/claude.js'
import { buildModel } from '../src/runtime/ai-sdk/provider.js'
import { selectTasks } from '../src/eval/tasks.js'
import { runLane } from '../src/eval/runner.js'
import { diffRuns } from '../src/eval/regression.js'
import { loadBaseline, writeBaseline, writeRun } from '../src/eval/store.js'
import type { CertDiff, LaneResult, RunArtifact, Task, Tier } from '../src/eval/types.js'

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

/** Print the regression comparison against the committed baseline. */
function printRegression(diff: CertDiff): void {
  console.log('\n=== Regression vs baseline ===')
  for (const l of diff.lanes) {
    const delta = l.currentPass - l.baselinePass
    const sign = delta > 0 ? `+${delta}` : String(delta)
    console.log(`  ${l.lane}: ${l.currentPass}/${l.total} (${sign} vs baseline)`)
    if (l.regressions.length) console.log(`    REGRESSED: ${l.regressions.join(', ')}`)
    if (l.fixes.length) console.log(`    fixed:     ${l.fixes.join(', ')}`)
    if (l.added.length) console.log(`    added:     ${l.added.join(', ')}`)
    if (l.removed.length) console.log(`    removed:   ${l.removed.join(', ')}`)
  }
  if (diff.missingLanes.length) console.log(`  MISSING LANES (certified but not run this time): ${diff.missingLanes.join(', ')}`)
  const bad = diff.hasRegression || diff.missingLanes.length > 0
  console.log(bad ? '  RESULT: FAIL (regressions or missing certified lanes)' : '  RESULT: no regressions')
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
  const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1] as Task['category'] | undefined
  const tierArg = (args.find(a => a.startsWith('--tier='))?.split('=')[1] ?? 'smoke') as Tier
  if (tierArg !== 'smoke' && tierArg !== 'full') throw new Error(`Unknown --tier='${tierArg}' (smoke | full)`)

  if (!args.includes('--mcp')) process.env.AI_MCP = 'off' // keep eval runs lean by default
  // The claude lane spawns the Claude Code CLI, which refuses to launch nested
  // inside another Claude Code session (CLAUDECODE env marker). From a normal
  // terminal that marker is absent and the lane just works. Pass --allow-nested
  // to apply the CLI's own documented bypass (unset CLAUDECODE).
  if (args.includes('--allow-nested')) delete process.env.CLAUDECODE

  const tasks = selectTasks({ tier: tierArg, name: taskFilter, category: categoryFilter })
  if (tasks.length === 0) throw new Error(`No tasks matched (task='${taskFilter ?? ''}' category='${categoryFilter ?? ''}' tier='${tierArg}')`)

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
    console.log(`\n=== Lane: ${name} ===`)
    const lane = await runLane(name, runtime, tasks, r =>
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.task.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${r.pass ? '' : r.detail}`),
    )
    laneResults.push(lane)
  }

  if (laneResults.length > 1) printMatrix(tasks, laneResults)

  const artifact: RunArtifact = { version: 1, createdAt: new Date().toISOString(), tier: tierArg, lanes: laneResults }

  if (args.includes('--save')) {
    const path = writeRun(artifact)
    console.log(`\nSaved run to ${path}`)
  }

  if (args.includes('--update-baseline')) {
    const path = writeBaseline(artifact)
    console.log(`\nBaseline updated: ${path}`)
  }

  // Regression gate: compare against the committed baseline when asked.
  let regressed = false
  if (args.includes('--baseline')) {
    const baseline = loadBaseline()
    if (!baseline) {
      console.log('\n=== Regression vs baseline ===\n  no baseline found (run --update-baseline to set one)')
    } else {
      const diff = diffRuns(baseline, artifact)
      printRegression(diff)
      // A certified lane that did not run is under-verification, not a pass.
      regressed = diff.hasRegression || diff.missingLanes.length > 0
    }
  }

  const allPass = laneResults.every(l => l.results.every(r => r.pass))
  console.log(`\n${allPass ? 'EVAL PASS' : 'EVAL FAIL'} (${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${lanes.length} lane${lanes.length === 1 ? '' : 's'}, tier=${tierArg})`)
  process.exit(allPass && !regressed ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
