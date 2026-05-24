import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'

// Auto-detect from cwd (same pattern as dreaming/index.ts)
const projectKey = process.cwd().replace(/\//g, '-').replace(/^-/, '')
const PROJECT_DIR = resolve(homedir(), `.claude/projects/${projectKey}`)

const env = process.env
const FIVE_HOUR_CAP = parseInt(env['COCKPIT_5H_TOKEN_CAP'] ?? '8000000', 10)   // tune to your plan
const DAILY_TOKEN_CAP = parseInt(env['COCKPIT_DAILY_TOKEN_CAP'] ?? '40000000', 10)
const DAILY_SESSION_CAP = parseInt(env['COCKPIT_DAILY_SESSION_CAP'] ?? '50', 10)

type UsageRow = { ts: number; tokens: number }

// Billable fresh tokens per turn. Cache reads are excluded because they
// re-count the same cached context every turn and inflate totals 10-100x.
// Cache creation IS counted (it's a real write, billed at 1.25x).
function tokensFromUsage(u: any): number {
  if (!u || typeof u !== 'object') return 0
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  )
}

function* iterUsageRows(filepath: string): Generator<UsageRow> {
  let text: string
  try { text = readFileSync(filepath, 'utf8') } catch { return }
  for (const line of text.split('\n')) {
    if (!line) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    const usage = row?.message?.usage
    const ts = row?.timestamp ? Date.parse(row.timestamp) : NaN
    if (!usage || Number.isNaN(ts)) continue
    yield { ts, tokens: tokensFromUsage(usage) }
  }
}

function recentJsonlFiles(maxAgeMs: number): string[] {
  let entries: string[] = []
  try { entries = readdirSync(PROJECT_DIR) } catch { return [] }
  const now = Date.now()
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const fp = join(PROJECT_DIR, name)
    try {
      const st = statSync(fp)
      if (now - st.mtimeMs <= maxAgeMs) out.push(fp)
    } catch { /* skip */ }
  }
  return out
}

export type UsageSnapshot = {
  fiveHourWindow: { used: number; cap: number; resetsAt: string }
  todayWindow: { used: number; cap: number; resetsAt: string }
  dailySessions: { used: number; cap: number; resetsAt: string }
}

export function getUsageSnapshot(): UsageSnapshot {
  const now = Date.now()
  const fiveH = 5 * 60 * 60 * 1000
  const oneDay = 24 * 60 * 60 * 1000
  const torontoMidnight = startOfTorontoDay(now)
  const tomorrowMidnight = torontoMidnight + oneDay

  // Read files modified within the last 5h or since today's midnight
  const horizon = Math.max(fiveH, now - torontoMidnight) + 60 * 60 * 1000
  const files = recentJsonlFiles(horizon)

  let fiveHTokens = 0
  let todayTokens = 0
  const sessionStartsToday = new Set<string>()

  for (const fp of files) {
    let touchedToday = false
    for (const r of iterUsageRows(fp)) {
      if (now - r.ts <= fiveH) fiveHTokens += r.tokens
      if (r.ts >= torontoMidnight) {
        todayTokens += r.tokens
        touchedToday = true
      }
    }
    if (touchedToday) {
      const sessionId = fp.split('/').pop()!.replace('.jsonl', '')
      sessionStartsToday.add(sessionId)
    }
  }

  return {
    fiveHourWindow: {
      used: fiveHTokens,
      cap: FIVE_HOUR_CAP,
      resetsAt: new Date(now + fiveH).toISOString(),
    },
    todayWindow: {
      used: todayTokens,
      cap: DAILY_TOKEN_CAP,
      resetsAt: new Date(tomorrowMidnight).toISOString(),
    },
    dailySessions: {
      used: sessionStartsToday.size,
      cap: DAILY_SESSION_CAP,
      resetsAt: new Date(tomorrowMidnight).toISOString(),
    },
  }
}

export function getActivitySeries(bucketMs = 5 * 60 * 1000, windowMs = 24 * 60 * 60 * 1000): { t: string; tokens: number }[] {
  const now = Date.now()
  const start = now - windowMs
  const buckets = new Map<number, number>()
  for (const fp of recentJsonlFiles(windowMs + 60 * 60 * 1000)) {
    for (const r of iterUsageRows(fp)) {
      if (r.ts < start) continue
      const b = Math.floor(r.ts / bucketMs) * bucketMs
      buckets.set(b, (buckets.get(b) ?? 0) + r.tokens)
    }
  }
  // Fill empties so the chart is continuous
  const out: { t: string; tokens: number }[] = []
  const firstBucket = Math.floor(start / bucketMs) * bucketMs
  const lastBucket = Math.floor(now / bucketMs) * bucketMs
  for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
    out.push({ t: new Date(b).toISOString(), tokens: buckets.get(b) ?? 0 })
  }
  return out
}

// --- helpers ---

function startOfTorontoDay(nowMs: number): number {
  // America/Toronto is UTC-5 (EST) or UTC-4 (EDT). Let Intl resolve the offset.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(new Date(nowMs))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  // Reconstruct "today midnight" in Toronto by subtracting current ET hours/min/sec from now
  const h = parseInt(get('hour'), 10)
  const m = parseInt(get('minute'), 10)
  const s = parseInt(get('second'), 10)
  return nowMs - ((h * 3600 + m * 60 + s) * 1000)
}

export { logger as _logger } // keep import used
