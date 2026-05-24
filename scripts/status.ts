import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// homedir no longer needed for Telegram mode
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const STORE_DIR = resolve(PROJECT_ROOT, 'store')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}
function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}
function fail(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`)
}

function main(): void {
  console.log(`\n${BOLD}${CYAN}ClaudeClaw Status${RESET}\n`)

  // Node version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js v${nodeVersion}`)
  } else {
    fail(`Node.js v${nodeVersion} (need v20+)`)
  }

  // Claude CLI
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 })
    if (result.status === 0) {
      ok(`Claude CLI: ${result.stdout.trim()}`)
    } else {
      fail('Claude CLI not found')
    }
  } catch {
    fail('Claude CLI not found')
  }

  // .env
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (existsSync(envPath)) {
    ok('.env file exists')
    const envContent = readFileSync(envPath, 'utf-8')

    // Check bot token
    if (envContent.includes('TELEGRAM_BOT_TOKEN="') && !envContent.includes('TELEGRAM_BOT_TOKEN=""')) {
      ok('Telegram bot token configured')
    } else {
      fail('TELEGRAM_BOT_TOKEN not set')
    }

    // Check chat ID
    const chatIdMatch = envContent.match(/ALLOWED_CHAT_ID="?([^"\n]*)"?/)
    if (chatIdMatch?.[1]) {
      ok(`Allowed chat ID: ${chatIdMatch[1]}`)
    } else {
      warn('ALLOWED_CHAT_ID not set (accepting all messages)')
    }

    // TTS
    if (envContent.includes('ELEVENLABS_API_KEY="') && !envContent.includes('ELEVENLABS_API_KEY=""')) {
      ok('ElevenLabs TTS configured')
    } else {
      warn('ElevenLabs TTS not configured')
    }

    // Video
    if (envContent.includes('GOOGLE_API_KEY="') && !envContent.includes('GOOGLE_API_KEY=""')) {
      ok('Google Gemini (video) configured')
    } else {
      warn('Google Gemini (video) not configured')
    }
  } else {
    fail('.env file missing (run npm run setup)')
  }

  // Database
  const dbPath = resolve(STORE_DIR, 'claudeclaw.db')
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true })
      const sessionCount = (
        db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
      ).c
      ok(`Database: ${sessionCount} active session(s)`)

      try {
        const memoryCount = (
          db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }
        ).c
        ok(`Memories: ${memoryCount} stored`)
      } catch {
        warn('Memories table not found')
      }

      try {
        const taskCount = (
          db.prepare("SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'active'").get() as {
            c: number
          }
        ).c
        ok(`Scheduled tasks: ${taskCount} active`)
      } catch {
        warn('Scheduled tasks table not found')
      }

      db.close()
    } catch (err) {
      fail(`Database error: ${err}`)
    }
  } else {
    warn('Database not yet created (starts on first run)')
  }

  // PID / running
  const pidPath = resolve(STORE_DIR, 'claudeclaw.pid')
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
    try {
      process.kill(pid, 0)
      ok(`Process running (PID ${pid})`)
    } catch {
      warn(`PID file exists (${pid}) but process not running`)
    }
  } else {
    warn('Not currently running')
  }

  // launchd service
  try {
    const result = spawnSync('launchctl', ['list', 'com.claudeclaw.app'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    if (result.status === 0) {
      ok('launchd service registered')
    } else {
      warn('launchd service not registered')
    }
  } catch {
    warn('Could not check launchd status')
  }

  console.log()
}

main()
