import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ANSI colors
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'

function ok(msg: string): void {
  console.log(`${GREEN}  ✓${RESET} ${msg}`)
}
function warn(msg: string): void {
  console.log(`${YELLOW}  ⚠${RESET} ${msg}`)
}
function fail(msg: string): void {
  console.log(`${RED}  ✗${RESET} ${msg}`)
}
function header(msg: string): void {
  console.log(`\n${BOLD}${CYAN}${msg}${RESET}\n`)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => resolve(answer.trim()))
  })
}

async function main(): Promise<void> {
  console.log(`
${BOLD}${CYAN} ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${RESET}
${BOLD}${CYAN}██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${RESET}
${BOLD}${CYAN}██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${RESET}
${BOLD}${CYAN}██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${RESET}
${BOLD}${CYAN}╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${RESET}
${BOLD}${CYAN} ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${RESET}
${BOLD}${CYAN} ██████╗██╗      █████╗ ██╗    ██╗${RESET}
${BOLD}${CYAN}██╔════╝██║     ██╔══██╗██║    ██║${RESET}
${BOLD}${CYAN}██║     ██║     ███████║██║ █╗ ██║${RESET}
${BOLD}${CYAN}██║     ██║     ██╔══██║██║███╗██║${RESET}
${BOLD}${CYAN}╚██████╗███████╗██║  ██║╚███╔███╔╝${RESET}
${BOLD}${CYAN} ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  Setup Wizard${RESET}
`)

  // --- Check requirements ---
  header('Checking requirements...')

  // Node version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js v${nodeVersion}`)
  } else {
    fail(`Node.js v${nodeVersion} — need v20+`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 })
    if (result.status === 0) {
      ok(`Claude CLI: ${result.stdout.trim()}`)
    } else {
      fail('Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code')
      process.exit(1)
    }
  } catch {
    fail('Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code')
    process.exit(1)
  }

  // Build project
  header('Building project...')
  try {
    execFileSync('npm', ['install'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
    ok('Dependencies installed')
  } catch {
    fail('npm install failed')
    process.exit(1)
  }

  try {
    execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
    ok('TypeScript compiled')
  } catch {
    fail('Build failed')
    process.exit(1)
  }

  // --- Collect config ---
  header('Configuration')

  const envValues: Record<string, string> = {}

  // Personalization
  const userName = await ask('Your name:')
  const assistantName = await ask('Name for your assistant (e.g. Aria, Max, Kai):')
  const city = await ask('Your city (e.g. Toronto):')
  const timezone = await ask('Your timezone (e.g. America/Toronto):')
  const aboutYou = await ask('Brief description of what you do:')
  const vibe = await ask('Personality vibe (e.g. "Direct and witty", "Warm and professional"):')

  // Telegram bot token
  console.log()
  console.log('  Create a bot via @BotFather on Telegram:')
  console.log('  1. Open Telegram, search for @BotFather')
  console.log('  2. Send /newbot and follow the prompts')
  console.log('  3. Copy the token it gives you')
  const botToken = await ask('Telegram bot token:')
  if (botToken) {
    envValues['TELEGRAM_BOT_TOKEN'] = botToken
  } else {
    warn('No bot token set. You must add TELEGRAM_BOT_TOKEN to .env before running.')
  }

  // ElevenLabs TTS
  console.log()
  console.log('  ElevenLabs gives your bot a voice (optional). Get a free API key at:')
  console.log('  https://elevenlabs.io')
  const elevenKey = await ask('ElevenLabs API key (or Enter to skip):')
  if (elevenKey) {
    envValues['ELEVENLABS_API_KEY'] = elevenKey
    const voiceId = await ask('ElevenLabs Voice ID:')
    envValues['ELEVENLABS_VOICE_ID'] = voiceId
  }

  // Gemini for video
  console.log()
  console.log('  Google Gemini API for video/image analysis (optional). Free tier at:')
  console.log('  https://aistudio.google.com')
  const googleKey = await ask('Google API key (or Enter to skip):')
  if (googleKey) {
    envValues['GOOGLE_API_KEY'] = googleKey
  }

  // Write .env
  header('Writing configuration...')
  const envLines = [
    '# AI Assistant Configuration',
    `TELEGRAM_BOT_TOKEN="${envValues['TELEGRAM_BOT_TOKEN'] ?? ''}"`,
    '# Send /chatid to the bot to get this, then fill it in',
    'ALLOWED_CHAT_ID=""',
    `ELEVENLABS_API_KEY="${envValues['ELEVENLABS_API_KEY'] ?? ''}"`,
    `ELEVENLABS_VOICE_ID="${envValues['ELEVENLABS_VOICE_ID'] ?? ''}"`,
    `GOOGLE_API_KEY="${envValues['GOOGLE_API_KEY'] ?? ''}"`,
    'SCHEDULER_ENABLED=true',
    'LOG_LEVEL=info',
    '',
  ]
  writeFileSync(resolve(PROJECT_ROOT, '.env'), envLines.join('\n'))
  ok('.env written')

  // Create store directory
  mkdirSync(resolve(PROJECT_ROOT, 'store'), { recursive: true })
  mkdirSync(resolve(PROJECT_ROOT, 'workspace', 'uploads'), { recursive: true })
  ok('Directories created')

  // Personalize CLAUDE.md from template
  header('Personalizing CLAUDE.md...')
  const claudeMdPath = resolve(PROJECT_ROOT, 'CLAUDE.md')
  let claudeContent = readFileSync(claudeMdPath, 'utf-8')
  claudeContent = claudeContent
    .replace(/\[ASSISTANT_NAME\]/g, assistantName || 'Assistant')
    .replace(/\[YOUR_NAME\]/g, userName || 'User')
    .replace(/\[PLATFORM\]/g, 'Telegram')
    .replace(/\[CITY\]/g, city || 'your city')
    .replace(/\[TIMEZONE\]/g, timezone || 'America/New_York')
    .replace(/\[PROJECT_PATH\]/g, PROJECT_ROOT)
    .replace(/\[Brief description:.*?\]/, aboutYou || 'Personal and professional tasks')
    .replace(/\[Describe the personality.*?\]/, vibe || 'Helpful, direct, and competent')
  writeFileSync(claudeMdPath, claudeContent)
  ok('CLAUDE.md personalized')

  // Install launchd service
  header('Background service')
  const installService = await ask('Install as launchd service (starts on login)? [Y/n]:')

  if (installService.toLowerCase() !== 'n') {
    const plistName = 'com.claudeclaw.app'
    const plistPath = resolve(homedir(), 'Library', 'LaunchAgents', `${plistName}.plist`)
    const nodePath = process.execPath
    const entryPoint = resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>`

    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, plist)
    ok(`Plist written to ${plistPath}`)

    // Unload if already loaded, then load
    try {
      spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' })
    } catch {
      // Not loaded yet, that's fine
    }
    try {
      execFileSync('launchctl', ['load', plistPath])
      ok('Service loaded and running')
    } catch (err) {
      warn(`Failed to load service: ${err}`)
      console.log(`    Load manually: launchctl load ${plistPath}`)
    }
  } else {
    console.log('  Skipped. Run manually with: npm start')
  }

  // Done
  header('Setup complete!')
  console.log('  Your ClaudeClaw is ready. Open Telegram and message your bot.')
  console.log('  First, send /chatid to get your chat ID, then add it to .env as ALLOWED_CHAT_ID.')
  console.log()
  console.log('  Useful commands in Telegram:')
  console.log('    /help     — list available commands')
  console.log('    /voice    — toggle voice replies')
  console.log('    /newchat  — clear session, start fresh')
  console.log('    /memory   — show stored memories')
  console.log('    /schedule — manage scheduled tasks')
  console.log()
  console.log('  Check status:  npm run status')
  console.log('  View logs:     tail -f /tmp/claudeclaw.log')
  console.log('  Dev mode:      npm run dev')
  console.log()

  rl.close()
}

main().catch((err) => {
  console.error(`${RED}Setup failed:${RESET}`, err)
  rl.close()
  process.exit(1)
})
