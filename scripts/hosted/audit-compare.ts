/**
 * Compare a hosted box's audit log with the off-box witness (card #196, part
 * 4). Run from your own machine:
 *
 *   npm run audit-compare -- <ip-or-host> [--out recovered.jsonl]
 *
 * Reads the box's log and its witness URL and token over SSH as havn, pages
 * the witness's copy from /v1/events, and prints what matches, what differs,
 * what the box lost and what it never sent. Exits 1 when the box's log does
 * not match. All the comparing happens here, not on the box.
 *
 * --out writes the witness's copy as JSON lines: the record of what happened
 * that survives a wiped or lost box (details as fingerprints only).
 *
 * If the box is gone, issue a fresh token for its name (npm run
 * witness-token) and pass it with HAVN_WITNESS_URL and HAVN_WITNESS_BOX_TOKEN;
 * the comparison then runs against an empty local log.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { compareLogs, ranges } from '../../src/assurance/audit-compare.js'
import type { ShippedEvent } from '../../src/assurance/witness-protocol.js'

const LOG = '/var/lib/havn-audit/audit.jsonl'

function ssh(host: string, command: string): string {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `havn@${host}`, command], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`ssh ${host} failed: ${r.stderr.trim()}`)
  return r.stdout
}

function envValue(env: string, key: string): string {
  const line = env.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : ''
}

export async function fetchWitness(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ShippedEvent[]> {
  const out: ShippedEvent[] = []
  for (;;) {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/events?from=${out.length + 1}&limit=5000`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`witness answered ${res.status}: ${await res.text()}`)
    const { events } = (await res.json()) as { events: ShippedEvent[] }
    out.push(...events)
    if (events.length < 5000) return out
  }
}

export async function main(argv: string[]): Promise<number> {
  const host = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  const outIdx = argv.indexOf('--out')
  const out = outIdx !== -1 ? argv[outIdx + 1] : undefined
  let url = process.env.HAVN_WITNESS_URL ?? ''
  let token = process.env.HAVN_WITNESS_BOX_TOKEN ?? ''
  let local = ''
  if (host) {
    const env = ssh(host, 'cat ~/havn/.env')
    url ||= envValue(env, 'AUDIT_WITNESS_URL')
    token ||= envValue(env, 'AUDIT_WITNESS_TOKEN')
    local = ssh(host, `cat ${LOG}`)
  }
  if (!url || !token) {
    console.error('Usage: npm run audit-compare -- <ip-or-host> [--out file]   (or HAVN_WITNESS_URL + HAVN_WITNESS_BOX_TOKEN with no host)')
    return 2
  }
  const witness = await fetchWitness(url, token)
  const r = compareLogs(local, witness)
  console.log(`witness holds ${r.witnessEvents} event(s), its chain ${r.witnessChainOk ? 'links from the start' : `is broken: ${r.witnessChainIssue}`}`)
  console.log(`the box holds ${r.localEvents} event(s)${r.unreadable ? `, plus ${r.unreadable} unreadable line(s)` : ''}`)
  console.log(`matched:  ${r.matched}`)
  if (r.edited.length) console.log(`DIFFERENT on the box: ${ranges(r.edited)}`)
  if (r.missing.length) console.log(`MISSING from the box: ${ranges(r.missing)}`)
  if (r.unsent.length) console.log(`only on the box (never accepted by the witness): ${ranges(r.unsent)}`)
  console.log(r.ok ? 'OK: everything the witness holds is on the box, unchanged.' : 'NOT OK: the box log does not match the witness.')
  if (out) {
    writeFileSync(out, witness.map((e) => JSON.stringify(e)).join('\n') + (witness.length ? '\n' : ''), { mode: 0o600 })
    console.log(`wrote the witness copy to ${out}`)
  }
  return r.ok ? 0 : 1
}

if (process.argv[1]?.match(/audit-compare\.(ts|js)$/)) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e)); process.exit(2) })
