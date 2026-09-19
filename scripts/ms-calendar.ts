/**
 * ms-calendar: the Outlook skill's calendar command. Behaviour and usage live in
 * src/ms/cli.ts; this file only wires in the real network, vault and clock.
 *
 *   node dist/scripts/ms-calendar.js today --account you@company.com
 */
import { runCalendar, runMain } from '../src/ms/cli.js'

runMain(runCalendar)
