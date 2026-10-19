/**
 * email-alerts: the email-alerts skill's control command. Behaviour and copy
 * live in src/email-alerts/control.ts and cli.ts; this file only routes logs
 * and prints the reply.
 *
 *   node dist/scripts/email-alerts.js status
 *
 * It runs as its own process beside the bot, against the same store
 * (AGENT_STORE_DIR or store/). stdout carries the reply and nothing else, so
 * the logger is pointed at stderr before anything that logs is loaded.
 */
process.env.LOG_DEST = 'stderr'

const { main } = await import('../src/email-alerts/cli.js')

main(process.argv.slice(2)).then(
  (out) => process.stdout.write(`${out}\n`, () => process.exit(0)),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`, () => process.exit(1))
  }
)
