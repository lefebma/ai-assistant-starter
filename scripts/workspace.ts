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
import { defaultSyncOne, scheduleWorkspace, stopWorkspaceService, unscheduleWorkspace } from '../src/workspace/service.js'
import { sendTelegram } from '../src/notify.js'

async function main(): Promise<void> {
  const notify = async (text: string): Promise<void> => { await sendTelegram(text) }
  const out = await workspaceCommand(process.argv.slice(2), {
    joinIO: makeJoinIO(),
    notify,
    schedule: (entry) => scheduleWorkspace(entry, { syncOne: defaultSyncOne, notify }),
    unschedule: unscheduleWorkspace,
  })
  console.log(out)
  // This process is about to exit; the long-lived service in src/index.ts owns
  // the real timers. Drop the ones we just made so node does not wait on them.
  stopWorkspaceService()
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
