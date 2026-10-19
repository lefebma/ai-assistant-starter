/**
 * The email-alerts control command as a process: real database, mailboxes,
 * model and clock around runControl. scripts/email-alerts.ts points logs at
 * stderr before loading this, because stdout is the owner's reply and the
 * agent relays it word for word.
 */
import { initDatabase } from '../db.js'
import { installTimezone } from '../env.js'
import { logger } from '../logger.js'
import { runControl, replayTriage } from './control.js'
import { discoverMailboxes } from './sources.js'

export async function main(argv: string[]): Promise<string> {
  initDatabase()
  const tz = installTimezone()
  const now = (): Date => new Date()

  // The agent runs this from inside its own session; the model runtime
  // refuses to nest under that marker, and replay needs the model.
  delete process.env.CLAUDECODE
  delete process.env.CLAUDE_CODE_SSE_PORT

  const run = async (message: string): Promise<string | null> => {
    const { getAgentRuntime } = await import('../runtime/index.js')
    return (await getAgentRuntime('cron').run({ message, model: 'haiku', isolated: true })).text
  }

  // The command word only: arguments can be addresses.
  logger.info({ command: argv[0] ?? '' }, 'email-alerts control')
  return runControl(argv, {
    boxes: () => discoverMailboxes(),
    triage: replayTriage(run, now, tz),
    now,
    tz,
  })
}
