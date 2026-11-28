/**
 * Running something on a hosted box as havn, from the operator's machine.
 *
 * havn has no ssh login (lock-box, card #308): a tool running as havn could
 * otherwise add a key to its own authorized_keys and get a shell outside the
 * egress fence. So every operator script goes in as havn-admin and drops to
 * havn with sudo. The script goes on stdin: ssh joins its arguments into one
 * remote command line, which loses quoting.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** ssh arguments that run stdin as a bash script, as havn, in havn's home. */
export function asHavnArgs(host: string): string[] {
  return [...SSH_OPTS, `havn-admin@${host}`, 'cd / && sudo -n -u havn -H -- bash -c "cd ~ && exec bash -s"']
}

/** Run `script` on the box as havn. */
export function runAsHavn(host: string, script: string, opts: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'input'> = {}): SpawnSyncReturns<string> {
  return spawnSync('ssh', asHavnArgs(host), { ...opts, encoding: 'utf-8', input: script })
}
