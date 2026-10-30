/**
 * The proactive control command as a process: real database, calendars and
 * clock around runControl. scripts/proactive.ts points logs at stderr before
 * loading this, because stdout is the owner's reply and the agent relays it
 * word for word.
 */
import { initDatabase } from '../db.js'
import { installTimezone } from '../env.js'
import { logger } from '../logger.js'
import { listAuthedAccounts } from '../ms/store.js'
import { outlookClient } from '../email-alerts/sources.js'
import { discoverCalendars } from './calendar.js'
import { runControl } from './control.js'

export async function main(argv: string[]): Promise<string> {
  initDatabase()
  const tz = installTimezone()
  // The command word only.
  logger.info({ command: argv[0] ?? '' }, 'proactive control')
  return runControl(argv, {
    calendars: () => discoverCalendars({ msAccounts: () => listAuthedAccounts(), client: outlookClient }),
    now: () => new Date(),
    tz,
  })
}
