/**
 * Usage report — token consumption per day / provider / model, from the
 * usage_log table the AI SDK runtime writes on every completed turn.
 *
 * Token counts only, no dollar figures: your provider's console is the
 * billing source of truth; this shows you where the tokens went.
 *
 * Usage (run compiled): node dist/scripts/usage-report.js [--days N]   (default 30)
 */
import { UsageMeter } from '../src/metering.js'

const daysIdx = process.argv.indexOf('--days')
const days = daysIdx !== -1 ? Math.max(1, Number(process.argv[daysIdx + 1]) || 30) : 30

const rows = new UsageMeter().summary({ sinceSecs: Math.floor(Date.now() / 1000) - days * 86400 })

if (rows.length === 0) {
  console.log(`No usage recorded in the last ${days} day(s). The AI SDK runtime (AGENT_RUNTIME=ai-sdk) records usage per turn; the claude runtime does not (your subscription covers it).`)
} else {
  console.log(`Token usage, last ${days} day(s):\n`)
  console.table(
    rows.map((r) => ({
      day: r.day,
      provider: r.provider,
      model: r.model,
      runs: r.runs,
      input: r.inputTokens,
      output: r.outputTokens,
      total: r.totalTokens,
      'cached-in': r.cachedInputTokens,
      reasoning: r.reasoningTokens,
    }))
  )
}
