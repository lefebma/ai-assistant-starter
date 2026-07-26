/**
 * Interactive setup wizard — the single cross-platform entry point
 * (absorbs the retired setup.sh). Question flow lives in src/setup/wizard.ts,
 * decisions in src/setup/plan.ts, filesystem work in src/setup/execute.ts;
 * this file is the readline shell around them.
 *
 * Usage: npm run setup
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { PROJECT_ROOT } from '../src/env.js'
import { runWizard, type Prompter } from '../src/setup/wizard.js'
import { buildEnvContent, buildSkillPlan, installedSkillsList } from '../src/setup/plan.js'
import { applyPlan } from '../src/setup/execute.js'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (m: string) => console.log(`  ${GREEN}✓${RESET} ${m}`)
const warn = (m: string) => console.log(`  ${YELLOW}⚠${RESET} ${m}`)
const fail = (m: string) => console.log(`  ${RED}✗${RESET} ${m}`)
const header = (m: string) => console.log(`\n${BOLD}${CYAN}${m}${RESET}`)

const rl = createInterface({ input: process.stdin, output: process.stdout })

const prompter: Prompter = {
  ask: async (q, def) => {
    const answer = (await rl.question(`  ${q}${def !== undefined && def !== '' ? ` [${def}]` : ''}: `)).trim()
    return answer || def || ''
  },
  choice: async (q, options) => {
    console.log(`\n  ${YELLOW}${q}${RESET}`)
    options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt}`))
    for (;;) {
      const raw = (await rl.question(`  Choose (1-${options.length}): `)).trim()
      const idx = parseInt(raw, 10) - 1
      if (idx >= 0 && idx < options.length) return options[idx]
      console.log(`  Enter a number between 1 and ${options.length}.`)
    }
  },
  yesNo: async (q) => /^y/i.test((await rl.question(`  ${q} (y/N): `)).trim()),
  say: (text) => console.log(`\n  ${YELLOW}${text}${RESET}`),
}

async function main(): Promise<void> {
  console.log(`${BOLD}${CYAN}\n  AI Assistant — Setup Wizard\n${RESET}`)

  header('Checking requirements...')
  const major = parseInt(process.versions.node.split('.')[0], 10)
  if (major >= 20) ok(`Node.js v${process.versions.node}`)
  else {
    fail(`Node.js v${process.versions.node} — need v20+`)
    process.exit(1)
  }
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000, shell: process.platform === 'win32' })
  if (claude.status === 0) ok(`Claude CLI: ${String(claude.stdout).trim()}`)
  else {
    fail('Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code')
    process.exit(1)
  }

  header('Configuration')
  const answers = await runWizard(prompter, PROJECT_ROOT)

  // Telegram-specific extras the platform env template leaves blank.
  let botToken = ''
  let chatId = ''
  if (answers.platform === 'Telegram') {
    prompter.say('Create a bot via @BotFather on Telegram (/newbot), then paste the token. Blank = fill in later.')
    botToken = await prompter.ask('Telegram bot token', '')
    chatId = await prompter.ask('Your Telegram chat ID (send /chatid to the bot later if unknown)', '')
  }

  header('Generating configuration...')

  const plan = buildSkillPlan(answers, homedir())
  const result = applyPlan(plan, PROJECT_ROOT)
  ok(`CLAUDE.md and skills installed (${installedSkillsList(answers)})`)
  for (const note of result.notes) warn(note)
  for (const skipped of result.skipped) warn(`kept existing: ${skipped}`)

  const envPath = resolve(PROJECT_ROOT, '.env')
  if (existsSync(envPath)) {
    warn('.env already exists — not overwriting (compare against .env.example for new settings)')
  } else {
    let env = buildEnvContent(answers)
    if (botToken) env = env.replace('TELEGRAM_BOT_TOKEN=', `TELEGRAM_BOT_TOKEN=${botToken}`)
    if (chatId) env = env.replace('ALLOWED_CHAT_ID=', `ALLOWED_CHAT_ID=${chatId}`)
    writeFileSync(envPath, env)
    ok('.env written')
  }

  mkdirSync(resolve(PROJECT_ROOT, 'projects'), { recursive: true })
  mkdirSync(resolve(PROJECT_ROOT, 'store'), { recursive: true })
  mkdirSync(resolve(PROJECT_ROOT, 'workspace', 'uploads'), { recursive: true })
  ok('Directories created')

  header('Building...')
  try {
    execFileSync('npm', ['install'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    ok('Dependencies installed and TypeScript compiled')
  } catch {
    fail('npm install / build failed — fix and re-run npm run setup')
    process.exit(1)
  }

  header('Setup complete! Next steps:')
  let step = 1
  if (!botToken || !chatId) console.log(`  ${step++}. Fill in your bot credentials in .env (see docs/SETUP-GUIDE.md)`)
  if (answers.gmailAddress) {
    console.log(`  ${step++}. Authenticate Gmail with the gog CLI:`)
    console.log(`       gog auth add ${answers.gmailAddress} --services gmail,calendar`)
    if (answers.gmailAddress2) console.log(`       gog auth add ${answers.gmailAddress2} --services gmail,calendar`)
  }
  if (answers.outlookAddress) console.log(`  ${step++}. Set up Microsoft 365 credentials (docs/SETUP-GUIDE.md > Outlook)`)
  if (answers.skills.wordsmith) console.log(`  ${step++}. Optional: drop writing samples into skills/wordsmith/voice-samples/`)
  console.log(`  ${step++}. Test locally:  node dist/src/index.js`)
  console.log(`  ${step++}. Install as a service:  node dist/scripts/service.js install`)
  console.log(`  ${step++}. Message your bot and say hello!\n`)

  rl.close()
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
