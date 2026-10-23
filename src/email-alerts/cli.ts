/**
 * The email-alerts control command as a process: real database, mailboxes,
 * model and clock around runControl. scripts/email-alerts.ts points logs at
 * stderr before loading this, because stdout is the owner's reply and the
 * agent relays it word for word.
 */
import { initDatabase } from '../db.js'
import { installTimezone, readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { aiPausedNow } from '../ai-limit.js'
import { runControl, replayTriage } from './control.js'
import { discoverMailboxes } from './sources.js'
import { withTimeout } from './triage.js'

/**
 * The agent's shell does not hand the subscription token to the commands it
 * runs, so a replay asked for in chat failed every model read with "Not
 * logged in". Read it from .env, where the service gets it (systemd's
 * EnvironmentFile on hosted boxes). Only this token: an API key in the environment would move every turn onto
 * API billing, which the runtime keeps to its overflow lane.
 */
export function loadAgentToken(
  env: NodeJS.ProcessEnv = process.env,
  lookup: (name: string) => string | undefined = (name) => readEnvFile([name])[name]?.trim() || undefined
): void {
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return
  const token = lookup('CLAUDE_CODE_OAUTH_TOKEN')
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
}

export async function main(argv: string[]): Promise<string> {
  if (argv[0] === 'replay' && aiPausedNow()) {
    logger.info('AI allowance used up, replay not run')
    return "The assistant's AI allowance for this month is used up, so a replay can't run now."
  }
  initDatabase()
  const tz = installTimezone()
  const now = (): Date => new Date()

  // The agent runs this from inside its own session; the model runtime
  // refuses to nest under that marker, and replay needs the model.
  delete process.env.CLAUDECODE
  delete process.env.CLAUDE_CODE_SSE_PORT
  loadAgentToken()

  const run = withTimeout(async (message, signal) => {
    const { getAgentRuntime } = await import('../runtime/index.js')
    return (await getAgentRuntime('cron').run({ message, model: 'haiku', isolated: true, signal })).text
  })

  // The command word only: arguments can be addresses.
  logger.info({ command: argv[0] ?? '' }, 'email-alerts control')
  return runControl(argv, {
    boxes: () => discoverMailboxes(),
    triage: replayTriage(run, now, tz),
    now,
    tz,
  })
}
