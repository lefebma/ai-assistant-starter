/**
 * Approving a refused site from chat (card #306).
 *
 * When a chat turn's tools are refused a site only because it is on no list,
 * the owner gets a card after the reply. What the card offers depends on
 * EGRESS_APPROVER in root-owned /etc/havn/egress.env, which only whoever runs
 * the box can set:
 *   - owner:    "Allow example.com?" with Allow and Deny
 *   - operator: (the default) Ask for access, which emails a request to whoever
 *               runs the box, and Not needed
 *
 * Only a person's tap or typed /egress command changes anything, and the
 * change itself is made by the root helper (havn-egressd), which takes it only
 * from the assistant's own process, never from one of its tools, and only
 * when the box allows owner approval. Approved sites go on the read list and
 * stay until /egress remove. A Deny or Not needed is remembered, so the same
 * site is never offered twice. Every answer goes to the audit log.
 *
 * Cards go to the main chat only: another chat sees the refusal in the reply
 * and nothing else.
 */
import { connect } from 'node:net'
import { AUDIT_DIR, PROJECT_ROOT, liveEgressSettings, type EgressApprover } from '../config.js'
import { getDb } from '../db.js'
import { getAuditTrail } from '../assurance/audit-trail.js'
import { logger } from '../logger.js'
import { EGRESS_SOCKET } from './hosted.js'
import { approvableHost, listFromEnv, parseRule } from './policy.js'

export const ALLOW = 'Allow'
export const DENY = 'Deny'
export const ASK = 'Ask for access'
export const NOT_NEEDED = 'Not needed'
export const buttonsFor = (a: EgressApprover): string[] => (a === 'owner' ? [ALLOW, DENY] : [ASK, NOT_NEEDED])

/** At most this many cards after one turn. */
export const MAX_OFFERS = 2

type Status = 'offered' | 'allowed' | 'declined' | 'asked' | 'removed'
type Row = { host: string; status: Status; card: string | null }

function row(host: string): Row | undefined {
  return getDb().prepare('SELECT host, status, card FROM egress_sites WHERE host = ?').get(host) as Row | undefined
}

function setStatus(host: string, status: Status, card: string | null = null): void {
  getDb().prepare(`INSERT INTO egress_sites (host, status, card, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET status = excluded.status, card = COALESCE(excluded.card, egress_sites.card), updated_at = excluded.updated_at`)
    .run(host, status, card, Math.floor(Date.now() / 1000))
}

/** Exact hosts on either list now (wildcards and ports are left to the policy). */
function listed(host: string): boolean {
  const live = liveEgressSettings()
  return [...listFromEnv(live.allow), ...listFromEnv(live.read)].some((e) => {
    const r = parseRule(e)
    return r !== null && r.port === undefined && (r.wildcard ? host.endsWith(`.${r.host}`) : r.host === host)
  })
}

/** The refused sites worth a card: approvable, not listed, never answered or offered before. */
export function sitesToOffer(sites: string[]): string[] {
  const out: string[] = []
  for (const s of sites) {
    const h = approvableHost(s)
    if (!h || out.includes(h) || listed(h)) continue
    const r = row(h)
    // Offered once and left unanswered is still not offered again: one card per site.
    if (r && r.status !== 'removed') continue
    out.push(h)
    if (out.length >= MAX_OFFERS) break
  }
  return out
}

export function offerText(host: string, approver: EgressApprover, buttons: boolean): string {
  const why = `Your assistant tried to open ${host} and it is not on this assistant's list of sites, so it could not.`
  if (approver === 'owner') {
    return buttons
      ? `${why} Allow ${host}? Allow adds it for good (take it off with /egress remove ${host}).`
      : `${why} To allow it, reply /egress allow ${host}`
  }
  return buttons
    ? `${why} Ask for access sends a request to whoever looks after your assistant.`
    : `${why} Whoever looks after your assistant can add it.`
}

export function markOffered(host: string, card: string | null): void {
  setStatus(host, 'offered', card)
}

// --- the root helper ---------------------------------------------------------

export type HelperCall = (request: string) => Promise<string>

/** One request to havn-egressd. Resolves with its one-line answer. */
export const callHelper: HelperCall = (request) => new Promise((resolve) => {
  const s = connect(EGRESS_SOCKET)
  let out = ''
  const done = (v: string) => { s.destroy(); resolve(v) }
  s.setTimeout(5000, () => done('no: the helper did not answer'))
  s.on('connect', () => s.write(`${request}\n`))
  s.on('data', (b) => { out += b.toString('utf-8'); if (out.includes('\n')) done(out.trim()) })
  s.on('error', () => done('no: the helper is not running (is egress set up on this box?)'))
  s.on('end', () => done(out.trim() || 'no: no answer'))
})

const ok = (answer: string) => answer === 'ok' || answer.startsWith('ok:')
const why = (answer: string) => answer.replace(/^no:\s*/, '')

function audit(actor: string, outcome: 'allowed' | 'blocked' | 'denied', detail: string): void {
  try {
    getAuditTrail(AUDIT_DIR, PROJECT_ROOT)?.log.append({ runId: 'egress-approval', actor, action: 'egress-approval', outcome, detail: detail.slice(0, 500) })
  } catch {
    // Recording never decides the outcome.
  }
}

export type ApprovalDeps = {
  helper?: HelperCall
  /** Send a request to whoever runs the box. Resolves with the reply for the owner. */
  ask: (host: string) => Promise<string>
  approver?: () => EgressApprover
}

async function allow(host: string, actor: string, deps: ApprovalDeps): Promise<string> {
  if ((deps.approver ?? (() => liveEgressSettings().approver))() !== 'owner') {
    return `Sites on this assistant are added by whoever looks after it. Ask for access sends them a request.`
  }
  const answer = await (deps.helper ?? callHelper)(`allow ${host}`)
  if (!ok(answer)) {
    audit(actor, 'blocked', `allow ${host} :: ${why(answer)}`)
    logger.warn({ host, answer }, 'egress: could not add an approved site')
    return `I could not add ${host}: ${why(answer)}.`
  }
  setStatus(host, 'allowed')
  audit(actor, 'allowed', `allow ${host}`)
  return `Allowed ${host}. Ask again and it will open. To take it off: /egress remove ${host}`
}

/** A tap on a site card. Null when the card is not one, so the click goes on to the next handler. */
export async function resolveSiteClick(primary: boolean, cardId: string, label: string, actor: string, deps: ApprovalDeps): Promise<string | null> {
  if (![ALLOW, DENY, ASK, NOT_NEEDED].includes(label)) return null
  const r = getDb().prepare('SELECT host, status, card FROM egress_sites WHERE card = ?').get(cardId) as Row | undefined
  if (!r) return null
  if (!primary) return 'That one only works in your main chat.'
  if (r.status !== 'offered') return 'Already done.'
  if (label === DENY || label === NOT_NEEDED) {
    setStatus(r.host, 'declined')
    audit(actor, 'denied', `${label === DENY ? 'deny' : 'not needed'} ${r.host}`)
    return `Okay, I won't ask about ${r.host} again.`
  }
  if (label === ASK) {
    const reply = await deps.ask(r.host)
    setStatus(r.host, 'asked')
    audit(actor, 'denied', `asked for ${r.host}`)
    return reply
  }
  return allow(r.host, actor, deps)
}

/**
 * /egress: list, allow <site> (owner approval only), remove <site>. Main chat only.
 */
export async function egressCommand(primary: boolean, enforced: boolean, arg: string, actor: string, deps: ApprovalDeps): Promise<string> {
  if (!primary) return 'That only works in your main chat.'
  if (!enforced) return 'The site list is off on this assistant: its tools can open any site.'
  const [verb = 'list', target = ''] = arg.trim().split(/\s+/)
  const live = liveEgressSettings()
  if (verb === 'list' || verb === '') {
    const allowList = listFromEnv(live.allow)
    const read = listFromEnv(live.read)
    return [
      'Sites your assistant can open, besides your connected accounts:',
      read.length ? read.map((h) => `- ${h}`).join('\n') : '- none yet',
      ...(allowList.length ? ['Sites it can also send to:', allowList.map((h) => `- ${h}`).join('\n')] : []),
      live.approver === 'owner'
        ? 'When it is refused a site, I ask you. /egress remove <site> takes one off.'
        : 'When it is refused a site, I offer to ask whoever looks after your assistant. /egress remove <site> takes one off.',
    ].join('\n')
  }
  const host = approvableHost(target)
  if (verb === 'allow' || verb === 'remove') {
    if (!host) return target ? `${target} is not a site name I can add or remove (one name like example.com, no addresses or wildcards).` : `Which site? /egress ${verb} example.com`
    if (verb === 'allow') return allow(host, actor, deps)
    const answer = await (deps.helper ?? callHelper)(`remove ${host}`)
    if (!ok(answer)) {
      audit(actor, 'blocked', `remove ${host} :: ${why(answer)}`)
      return `I could not take off ${host}: ${why(answer)}.`
    }
    setStatus(host, 'removed')
    audit(actor, 'allowed', `remove ${host}`)
    return `Took ${host} off the list.`
  }
  return 'Use /egress list, /egress allow <site> or /egress remove <site>.'
}
