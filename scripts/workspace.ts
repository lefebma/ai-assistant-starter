/**
 * Shared workspace CLI. Same handlers as the /workspace chat command.
 *
 *   npm run workspace -- join <name> <ssh-url>
 *   npm run workspace -- status
 *   npm run workspace -- sync [name]
 *   npm run workspace -- leave <name>
 */
import { workspaceCommand } from '../src/workspace/commands.js'
import { makeJoinIO } from '../src/workspace/io.js'
import { sendTelegram } from '../src/notify.js'

async function main(): Promise<void> {
  const out = await workspaceCommand(process.argv.slice(2), {
    joinIO: makeJoinIO(),
    notify: async (text) => { await sendTelegram(text) },
  })
  console.log(out)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
