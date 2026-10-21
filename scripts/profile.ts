/**
 * profile: the owner-profile command the assistant runs in chat. Behaviour
 * and copy live in src/onboarding/profile-cli.ts; this file only routes logs
 * and prints the reply.
 *
 *   node dist/scripts/profile.js set --owner-name "Jane"
 *
 * stdout carries the reply and nothing else (the assistant relays it), so the
 * logger is pointed at stderr before anything that logs is loaded. A message
 * the owner can act on (InputError) is the reply, with exit code 1.
 */
process.env.LOG_DEST = 'stderr'

const { main } = await import('../src/onboarding/profile-cli.js')
const { InputError } = await import('../src/setup/web/answers.js')

main(process.argv.slice(2)).then(
  (out) => process.stdout.write(`${out}\n`, () => process.exit(0)),
  (err: unknown) => {
    if (err instanceof InputError) {
      process.stdout.write(`${err.message}\n`, () => process.exit(1))
      return
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`, () => process.exit(1))
  }
)
