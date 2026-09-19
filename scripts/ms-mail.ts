/**
 * ms-mail: the Outlook skill's mail command. Behaviour and usage live in
 * src/ms/cli.ts; this file only wires in the real network, vault and clock.
 *
 *   node dist/scripts/ms-mail.js inbox --account you@company.com
 */
import { runMail, runMain } from '../src/ms/cli.js'

runMain(runMail)
