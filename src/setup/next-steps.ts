/**
 * The "Setup complete! Next steps:" list.
 *
 * This lived inline in scripts/setup.ts as a run of console.log calls with a
 * hand-incremented counter, and produced three separate bugs there: commands
 * with relative paths that only worked from the install root, a Gmail step
 * that assumed a CLI the machine did not have, and a "Test locally" step
 * printed directly above "Already running in the background".
 *
 * That last one was the worst of the three. index.ts acquireLock() SIGTERMs
 * whatever holds the PID file, and the launchd job sets KeepAlive, so running
 * the app in the foreground while the service is installed makes the two kill
 * each other in a loop: the foreground process stops the service, launchd
 * restarts it, and the restarted service stops the foreground process. What
 * the owner sees is the app dying on launch for no reason.
 *
 * So: pure, and tested. The shell only renders what this returns.
 */

export interface NextStep {
  text: string
  /** Command lines shown indented beneath the step. */
  commands?: string[]
}

export interface NextStepsInput {
  /** Bot token or chat id still blank in .env. */
  needsBotCredentials: boolean
  gmailAddress: string
  gmailAddress2: string
  /** gog is not installed and setup could not install it. */
  gogMissing: boolean
  outlookAddress: string
  /** The background service was installed and is running now. */
  serviceInstalled: boolean
  /** Quoted absolute path to the interpreter to use. */
  nodeBin: string
  /** Quoted absolute path to dist/src/index.js. */
  appEntry: string
  /** Quoted absolute path to dist/scripts/service.js. */
  serviceEntry: string
}

export function buildNextSteps(i: NextStepsInput): NextStep[] {
  const steps: NextStep[] = []

  if (i.needsBotCredentials) {
    steps.push({ text: 'Fill in your bot credentials in .env (see docs/SETUP-GUIDE.md)' })
  }

  if (i.gmailAddress) {
    if (i.gogMissing) {
      steps.push({
        text: 'Install the gog CLI (see docs/SETUP-GUIDE.md > Gmail):',
        commands: ['brew install gogcli   (no Homebrew? the guide covers direct download)'],
      })
    }
    // gog needs a Google OAuth client before auth add works — a fresh machine
    // that runs only the auth command hits an error with no path forward.
    steps.push({
      text: 'Authenticate Gmail with the gog CLI (needs a Google OAuth client — docs/SETUP-GUIDE.md > Gmail):',
      commands: [
        'gog auth credentials set ~/Downloads/client_secret_*.json',
        `gog auth add ${i.gmailAddress} --services gmail,calendar`,
        ...(i.gmailAddress2 ? [`gog auth add ${i.gmailAddress2} --services gmail,calendar`] : []),
      ],
    })
  }

  if (i.outlookAddress) {
    steps.push({ text: 'Set up Microsoft 365 credentials (docs/SETUP-GUIDE.md > Outlook)' })
  }
  // Wordsmith voice samples are always a good idea — mention unconditionally.
  steps.push({ text: 'Optional: drop writing samples into skills/wordsmith/voice-samples/' })

  // Safe to run alongside the service: --selftest returns before the app takes
  // the PID lock, so it never disturbs a running instance.
  steps.push({
    text: 'Verify the install:',
    commands: [`${i.nodeBin} ${i.appEntry} --selftest --live`],
  })

  if (i.serviceInstalled) {
    // With no token the app exits on startup (createAdapter throws) and the
    // launchd job retries it, so it is installed but not yet answering.
    // Saying "already running" there sends the owner looking for a bot that
    // cannot reply. It picks itself up once .env is filled; the Restart
    // shortcut just makes that immediate.
    steps.push({
      text: i.needsBotCredentials
        ? 'It is installed and will start answering as soon as .env has your credentials. Use the Restart shortcut after you save the file to skip the wait.'
        : 'It is already running in the background. Use the Restart shortcut if you change .env later.',
    })
  } else {
    // Only offered when nothing is running: see the header comment.
    steps.push({ text: 'Test it in this window (Ctrl-C to stop):', commands: [`${i.nodeBin} ${i.appEntry}`] })
    steps.push({ text: 'Install as a service so it runs on its own:', commands: [`${i.nodeBin} ${i.serviceEntry} install`] })
  }

  steps.push({ text: 'Message your bot and say hello!' })
  return steps
}

/** Numbered plain-text rendering, one entry per line. */
export function renderNextSteps(steps: NextStep[]): string[] {
  const lines: string[] = []
  steps.forEach((step, idx) => {
    lines.push(`  ${idx + 1}. ${step.text}`)
    for (const command of step.commands ?? []) lines.push(`       ${command}`)
  })
  return lines
}
