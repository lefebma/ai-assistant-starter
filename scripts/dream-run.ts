/**
 * Scheduler-friendly wrapper for the nightly dreaming job: logs to
 * logs/dream.log, notifies via Telegram only on failure, and clears the
 * Claude Code nesting guards so manual invocations from a Claude Code
 * terminal still work.
 *
 * Usage (run compiled, from launchd / cron / Task Scheduler):
 *   node dist/scripts/dream-run.js
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'
import { sendTelegram } from '../src/notify.js'

const LOG_DIR = resolve(PROJECT_ROOT, 'logs')
const LOG_FILE = resolve(LOG_DIR, 'dream.log')
const ENTRY = resolve(PROJECT_ROOT, 'dist', 'src', 'dreaming', 'index.js')

mkdirSync(LOG_DIR, { recursive: true })

function log(line: string): void {
  appendFileSync(LOG_FILE, `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${line}\n`)
}

async function fail(msg: string): Promise<never> {
  log(`FAIL: ${msg}`)
  await sendTelegram(`Dream job failed: ${msg} (see ${LOG_FILE})`)
  process.exit(1)
}

async function main(): Promise<void> {
  log('---- dream start ----')

  if (!existsSync(ENTRY)) return fail('dist/src/dreaming/index.js missing, run npm run build')

  // The Claude Agent SDK refuses to nest inside another Claude Code session.
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_SSE_PORT

  const child = spawn(process.execPath, [ENTRY], { cwd: PROJECT_ROOT, env })
  child.stdout.on('data', (d) => appendFileSync(LOG_FILE, String(d)))
  child.stderr.on('data', (d) => appendFileSync(LOG_FILE, String(d)))
  child.on('exit', async (code) => {
    if (code === 0) {
      log('---- dream ok ----')
    } else {
      await fail('dreaming agent exited non-zero')
    }
  })
  child.on('error', async (err) => fail(String(err)))
}

main()
