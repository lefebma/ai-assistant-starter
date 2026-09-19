/**
 * ms-auth: the Outlook skill's auth command. Behaviour and usage live in
 * src/ms/cli.ts; this file only wires in the real network, vault and clock.
 *
 *   node dist/scripts/ms-auth.js start --account you@company.com
 */
import { runAuth, runMain } from '../src/ms/cli.js'

runMain(runAuth)
