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
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { PROJECT_ROOT } from '../src/env.js'
import { runWizard, type Prompter } from '../src/setup/wizard.js'
import { checkRequirements, planBuildStep } from '../src/setup/requirements.js'
import { resolveBundledClaude } from '../src/infra/claude-bin.js'
import { checkClaudeAuth, spawnClaude } from '../src/infra/claude-auth.js'
import { resolveGogBin } from '../src/infra/gog-bin.js'
import { buildEnvContent, buildSkillPlan, installedSkillsList } from '../src/setup/plan.js'
import { buildNextSteps, renderNextSteps } from '../src/setup/next-steps.js'
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
  const bundledClaude = resolveBundledClaude(process.env, PROJECT_ROOT)
  let signedIn = checkClaudeAuth(bundledClaude, spawnClaude).loggedIn
  const report = checkRequirements({
    nodeVersion: process.versions.node,
    bundledClaude,
    signedIn,
  })
  if (report.fatal) {
    fail(report.fatal)
    process.exit(1)
  }
  for (const note of report.notes) ok(note)
  for (const w of report.warnings) warn(w)

  // Do the sign-in here, in the install call, rather than printing a command
  // for the owner to run alone later. This is the step that decides whether
  // the assistant can answer at all, and the old setup never mentioned it.
  const signIn = async (): Promise<void> => {
    if (signedIn) {
      ok('Already signed in to Claude on this machine')
      return
    }
    header('Signing in to Claude')
    if (!bundledClaude) {
      warn('Claude engine is missing from this install, so sign-in cannot run here.')
      console.log('    Re-run the installer, then run setup again.')
      return
    }
    console.log('  This opens a browser. Sign in with the account that carries your Claude plan.')
    if (!(await prompter.yesNo('Sign in now (recommended)?'))) {
      warn('Skipped. The assistant cannot answer messages until this is done.')
      return
    }
    // readline owns stdin; hand it to the child for the duration or the login
    // prompt and the wizard fight over every keystroke.
    rl.pause()
    spawnSync(bundledClaude, ['auth', 'login'], { stdio: 'inherit' })
    rl.resume()
    signedIn = checkClaudeAuth(bundledClaude, spawnClaude).loggedIn
    if (signedIn) ok('Signed in')
    else warn('Sign-in did not complete. Setup will continue, but the assistant cannot answer yet.')
  }

  // The next-steps list used to print `gog auth add ...` and nothing else; on
  // a fresh machine that command does not exist. Catch it here, while the
  // owner is still at the keyboard, instead of letting step 2 fail later.
  const gogInstalled = (): boolean => {
    const resolved = resolveGogBin(process.env)
    if (isAbsolute(resolved)) return existsSync(resolved)
    const probe = spawnSync(resolved, ['--version'], { encoding: 'utf-8', timeout: 5000, shell: process.platform === 'win32' })
    return probe.status === 0
  }
  const findBrew = (): string | null => {
    const candidate = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'].find(existsSync)
    if (candidate) return candidate
    const probe = spawnSync('brew', ['--version'], { encoding: 'utf-8', timeout: 5000 })
    return probe.status === 0 ? 'brew' : null
  }
  let gogMissing = false
  const ensureGog = async (): Promise<void> => {
    if (gogInstalled()) {
      ok('gog CLI found (the Gmail/Calendar backend)')
      return
    }
    warn('The gog CLI (the Gmail/Calendar backend) is not installed.')
    const brew = process.platform === 'win32' ? null : findBrew()
    if (brew && (await prompter.yesNo('Install it now with Homebrew?'))) {
      rl.pause()
      spawnSync(brew, ['install', 'gogcli'], { stdio: 'inherit' })
      rl.resume()
      if (gogInstalled()) {
        ok('gog CLI installed')
        return
      }
    }
    gogMissing = true
    warn('Gmail and Calendar will not work until gog is installed.')
    console.log('    See docs/SETUP-GUIDE.md > Gmail for install options (Homebrew or direct download).')
  }

  header('Configuration')
  const answers = await runWizard(prompter, PROJECT_ROOT, { signIn, ensureGog })

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

  const buildStep = planBuildStep({
    hasCompiledApp: existsSync(resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')),
    hasDependencies: existsSync(resolve(PROJECT_ROOT, 'node_modules')),
    hasBuildToolchain: existsSync(resolve(PROJECT_ROOT, 'node_modules', 'typescript')),
  })
  if (buildStep.build) {
    header('Building...')
    try {
      execFileSync('npm', ['install'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
      execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
      ok('Dependencies installed and TypeScript compiled')
    } catch (err) {
      fail('npm install / build failed — fix and re-run npm run setup')
      console.log(`    ${String(err)}`)
      process.exit(1)
    }
  } else {
    ok(`No build needed (${buildStep.reason})`)
  }

  // This wizard should be the last terminal the owner ever needs. Leaving the
  // service as a command they have to come back and type means the assistant
  // is installed but not running, which is indistinguishable from broken.
  const serviceEntry = resolve(PROJECT_ROOT, 'dist', 'scripts', 'service.js')
  let serviceInstalled = false
  if (existsSync(serviceEntry)) {
    header('Background service')
    if (await prompter.yesNo('Start the assistant automatically in the background (recommended)?')) {
      try {
        execFileSync(process.execPath, [serviceEntry, 'install'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
        serviceInstalled = true
      } catch (err) {
        warn(`Could not install the background service: ${String(err)}`)
        console.log(`    Install it later with: "${process.execPath}" dist/scripts/service.js install`)
      }
    }
  }

  // The last word on whether this install can do anything. Printed after .env
  // exists so it reflects what was actually written, and phrased as the one
  // thing to fix rather than buried in a list of next steps.
  header('Can your assistant reach a model?')
  const { credentialStatus } = await import('../src/selftest.js')
  const creds = await credentialStatus()
  if (creds.ok) {
    ok(creds.detail)
  } else {
    fail(creds.detail)
    if (creds.remedy) console.log(`    ${creds.remedy}`)
    console.log(`    ${BOLD}Everything else is installed. Until this is sorted, it will not reply.${RESET}`)
  }

  header('Setup complete! Next steps:')
  // Quote the running interpreter rather than a bare `node`: bundle installs
  // carry their own runtime and may have no system Node on PATH at all. Same
  // for the scripts: absolute paths, so the commands work from any directory.
  for (const line of renderNextSteps(
    buildNextSteps({
      needsBotCredentials: !botToken || !chatId,
      gmailAddress: answers.gmailAddress,
      gmailAddress2: answers.gmailAddress2,
      gogMissing,
      outlookAddress: answers.outlookAddress,
      wordsmith: answers.skills.wordsmith,
      serviceInstalled,
      nodeBin: `"${process.execPath}"`,
      appEntry: `"${resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')}"`,
      serviceEntry: `"${serviceEntry}"`,
    })
  )) {
    console.log(line)
  }
  console.log('')

  rl.close()
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
