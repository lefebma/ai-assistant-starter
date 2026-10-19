/**
 * email-alerts: the email-alerts skill's control command. Behaviour and copy
 * live in src/email-alerts/control.ts; this file only wires in the real
 * database, mailboxes, model and clock.
 *
 *   node dist/scripts/email-alerts.js status
 *
 * It runs as its own process beside the bot, against the same store
 * (AGENT_STORE_DIR or store/), so it opens the database itself.
 */
import { initDatabase } from '../src/db.js'
import { installTimezone } from '../src/env.js'
import { runControl, replayTriage } from '../src/email-alerts/control.js'
import { discoverMailboxes } from '../src/email-alerts/sources.js'

initDatabase()
const tz = installTimezone()
const now = (): Date => new Date()

// The agent runs this from inside its own session; the model runtime refuses
// to nest under that marker, and replay needs the model.
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_SSE_PORT

const run = async (message: string): Promise<string | null> => {
  const { getAgentRuntime } = await import('../src/runtime/index.js')
  return (await getAgentRuntime('cron').run({ message, model: 'haiku', isolated: true })).text
}

runControl(process.argv.slice(2), {
  boxes: () => discoverMailboxes(),
  triage: replayTriage(run, now, tz),
  now,
  tz,
}).then(
  (out) => process.stdout.write(`${out}\n`, () => process.exit(0)),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`, () => process.exit(1))
  }
)
