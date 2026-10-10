/**
 * imap-auth: connects a Yahoo, AOL, iCloud or other app-password mailbox.
 * Behaviour and usage live in src/imap/cli.ts; this file only wires in the
 * real network and vault.
 *
 *   node dist/scripts/imap-auth.js add --account you@yahoo.com
 */
import { runImapAuth, runMain } from '../src/imap/cli.js'

runMain(runImapAuth)
