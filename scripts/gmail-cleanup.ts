/**
 * Zero-cost Gmail cleanup sweep — deterministic replacement for the LLM-based
 * "Gmail Promo Cleanup" seed job (which burns ~22k tokens per run just to
 * check whether anything needs trashing).
 *
 * Two passes: promotions older than 3 months, anything older than 5 years.
 * Starred mail is always protected. Matches go to Trash (Gmail purges Trash
 * after 30 days on its own — that window is the safety net). A one-shot
 * scheduled task reports to Telegram only when something was trashed or an
 * error needs attention; a clean run costs zero tokens.
 *
 * Config (.env):
 *   GMAIL_CLEANUP_ACCOUNT   Gmail address to sweep (required)
 *   GMAIL_CLEANUP_CHAT_ID   Telegram chat for the report (default: ALLOWED_CHAT_ID)
 *   GOG_PATH                gog binary (default: "gog" on PATH)
 *   TIMEZONE                IANA zone for the report dispatch (default: system zone)
 *
 * Usage (run compiled, after npm run build):
 *   node dist/scripts/gmail-cleanup.js [--dry-run]
 *
 * Schedule it with launchd / cron / Task Scheduler — see docs/GMAIL-CLEANUP.md.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { readEnvFile, PROJECT_ROOT } from '../src/env.js'
import { cutoffDate, oneShotCron, buildReport } from '../src/gmail-cleanup/core.js'
import { runSweep } from '../src/gmail-cleanup/sweep.js'
import type { SweepIO } from '../src/gmail-cleanup/sweep.js'

const execFileAsync = promisify(execFile)

const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>
const ACCOUNT = env.GMAIL_CLEANUP_ACCOUNT ?? ''
const CHAT_ID = env.GMAIL_CLEANUP_CHAT_ID ?? env.ALLOWED_CHAT_ID ?? ''
const GOG = env.GOG_PATH ?? 'gog'
const TZ = env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const DRY_RUN = process.argv.includes('--dry-run')

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function makeIO(): SweepIO {
  return {
    async search(query, pageToken) {
      const args = ['gmail', 'search', query, '--max', '100', '--plain', '--account', ACCOUNT]
      if (pageToken) args.push('--page', pageToken)
      try {
        const { stdout } = await execFileAsync(GOG, args)
        return { ok: true, output: stdout }
      } catch (err) {
        return { ok: false, output: String(err) }
      }
    },
    async trash(ids) {
      const args = [
        'gmail', 'batch', 'modify',
        '--add', 'TRASH', '--remove', 'INBOX',
        '--force', '--account', ACCOUNT,
        ...ids,
      ]
      try {
        await execFileAsync(GOG, args)
        return true
      } catch {
        return false
      }
    },
  }
}

async function dispatchReport(prompt: string): Promise<boolean> {
  const cli = resolve(PROJECT_ROOT, 'dist/src/schedule-cli.js')
  const cron = oneShotCron(new Date())
  try {
    await execFileAsync(process.execPath, [
      cli, 'create', prompt, cron, CHAT_ID,
      '--name', 'Gmail cleanup report', '--silent', '--once', '--tz', TZ,
    ])
    return true
  } catch (err) {
    console.error(`${ts()} dispatch FAILED: ${String(err)}`)
    return false
  }
}

async function main(): Promise<void> {
  if (!ACCOUNT || !CHAT_ID) {
    console.error(`${ts()} ERROR: set GMAIL_CLEANUP_ACCOUNT (and ALLOWED_CHAT_ID or GMAIL_CLEANUP_CHAT_ID) in .env`)
    process.exit(1)
  }

  const now = new Date()
  const io = makeIO()
  const opts = { dryRun: DRY_RUN }

  const promo = await runSweep(
    {
      query: 'category:promotions older_than:3m -is:starred -in:trash',
      cutoff: cutoffDate(now, { months: 3 }),
      requiredLabel: 'CATEGORY_PROMOTIONS',
    },
    io,
    opts
  )
  const ancient = await runSweep(
    { query: 'older_than:5y -is:starred -in:trash', cutoff: cutoffDate(now, { years: 5 }) },
    io,
    opts
  )

  const totals = {
    promoTrashed: promo.trashed,
    ancientTrashed: ancient.trashed,
    skipped: promo.skipped + ancient.skipped,
    errors: [...promo.errors, ...ancient.errors],
  }

  if (DRY_RUN) {
    console.log(
      `${ts()} [dry-run] first page: promo=${totals.promoTrashed} ancient=${totals.ancientTrashed} ` +
        `skipped=${totals.skipped} errors=${totals.errors.length ? totals.errors.join('; ') : 'none'}`
    )
    return
  }

  const report = buildReport(totals)
  if (!report) {
    console.log(`${ts()} clean run - nothing to trash, no dispatch`)
    return
  }

  if (await dispatchReport(report)) {
    console.log(`${ts()} dispatched one-shot: trashed ${totals.promoTrashed} promo + ${totals.ancientTrashed} ancient${totals.errors.length ? ' [with errors]' : ''}`)
  } else {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`${ts()} FATAL: ${String(err)}`)
  process.exit(1)
})
