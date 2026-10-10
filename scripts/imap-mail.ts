/**
 * imap-mail: the IMAP skill's mail command. Behaviour and usage live in
 * src/imap/cli.ts; this file only wires in the real network and vault.
 *
 *   node dist/scripts/imap-mail.js inbox --account you@yahoo.com
 */
import { runImapMail, runMain } from '../src/imap/cli.js'

runMain(runImapMail)
