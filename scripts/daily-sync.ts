/**
 * Daily repo sync — thin CLI over src/sync/daily-sync.ts (where the logic
 * and its secret/key/size guards live, unit-tested). Pull --rebase, commit
 * drift as "auto-sync: <date> (<host>)", push with retry. Logs to
 * logs/daily-sync.log; Telegram notification only on failure.
 *
 * Usage (run compiled, from launchd / cron / Task Scheduler):
 *   node dist/scripts/daily-sync.js
 * Config: SYNC_BRANCH (default main), SYNC_REMOTE (default origin)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { hostname } from 'node:os'
import { PROJECT_ROOT, readEnvFile } from '../src/env.js'
import { runDailySync } from '../src/sync/daily-sync.js'
import { sendTelegram } from '../src/notify.js'

const execFileAsync = promisify(execFile)

const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>
const BRANCH = env.SYNC_BRANCH ?? 'main'
const REMOTE = env.SYNC_REMOTE ?? 'origin'
const LOG_DIR = resolve(PROJECT_ROOT, 'logs')
const LOG_FILE = resolve(LOG_DIR, 'daily-sync.log')

mkdirSync(LOG_DIR, { recursive: true })

const log = (line: string): void =>
  appendFileSync(LOG_FILE, `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${line}\n`)

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main(): Promise<void> {
  log('---- sync start ----')

  const result = await runDailySync(
    {
      git: async (...args) => {
        try {
          const { stdout, stderr } = await execFileAsync('git', args, { cwd: PROJECT_ROOT })
          if (stderr) appendFileSync(LOG_FILE, stderr)
          return { ok: true, out: stdout }
        } catch (err) {
          return { ok: false, out: String(err) }
        }
      },
      readFile: (path) => {
        try {
          return readFileSync(resolve(PROJECT_ROOT, path), 'utf-8')
        } catch {
          return null
        }
      },
      fileSize: (path) => {
        try {
          return statSync(resolve(PROJECT_ROOT, path)).size
        } catch {
          return 0
        }
      },
      log,
    },
    { branch: BRANCH, remote: REMOTE, date: ymdLocal(new Date()), host: hostname().split('.')[0] }
  )

  if (result.ok) {
    log('---- sync ok ----')
  } else {
    await sendTelegram(`Repo sync failed: ${result.message} (see ${LOG_FILE})`)
    process.exit(1)
  }
}

main().catch(async (err) => {
  log(`FATAL: ${String(err)}`)
  await sendTelegram(`Repo sync failed: ${String(err)} (see ${LOG_FILE})`)
  process.exit(1)
})
