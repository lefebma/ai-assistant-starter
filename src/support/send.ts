/**
 * Delivery for a confirmed support request.
 *
 * Email goes out through the same channel the product already uses for
 * Gmail: the gog CLI (see src/infra/gog-bin.ts and the gmail skill). When
 * gog is missing or the send fails — no email connected is the common case
 * — the request degrades to a local file under support-requests/ so nothing
 * the user wrote is lost.
 *
 * `--account` is always passed explicitly (resolveGmailAccount, reading the
 * deployed skills/gmail/SKILL.md), rather than relying on gog's "exactly one
 * stored token" auto-fallback for when --account is omitted. On a live
 * hosted install that fallback surfaced as "missing --account" while the
 * install actually had a keyring password mismatch (a truncated `cut -d=
 * -f2` during manual setup vs the full value systemd's EnvironmentFile=
 * parses) — the auto-select path silently swallowed the real decrypt
 * failure and reported it as "can't resolve an account" instead. Passing
 * --account explicitly doesn't fix a mismatched password, but it does
 * surface the real error instead of a misleading one, and it's simply
 * correct on any multi-account box (one client authorized 5 Google
 * accounts) where the fallback is ambiguous by definition regardless of
 * keyring health.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readEnvFile, PROJECT_ROOT } from '../env.js'
import { resolveGogBin } from '../infra/gog-bin.js'
import type { SupportDraft } from './draft.js'

/**
 * The gmail skill's own record of which account it's configured for —
 * `skills/gmail/SKILL.md` has an `Account:` line, written by the setup
 * wizard's template substitution. A box with more than one Google account
 * authorized (beyond what the wizard's two gmailAddress slots cover) may
 * have this hand-edited to `Default account:` to mark the primary among
 * several — matched case-insensitively on "account:" rather than the exact
 * wizard wording, so a manual edit like that doesn't silently break
 * resolution. Returns undefined if the skill isn't deployed/enabled or the
 * file doesn't match, so callers can fall back to omitting --account rather
 * than failing outright.
 */
export function resolveGmailAccount(projectRoot: string = PROJECT_ROOT): string | undefined {
  try {
    const content = readFileSync(resolve(projectRoot, 'skills', 'gmail', 'SKILL.md'), 'utf-8')
    const match = content.match(/account:\s*(\S+@\S+)\s*$/im)
    return match?.[1]
  } catch {
    return undefined
  }
}

/** Injected exec boundary so tests never send real email. */
export interface SendIO {
  exec(cmd: string, args: string[]): Promise<{ code: number; out: string }>
}

const SEND_TIMEOUT_MS = 30_000

export function realSendIO(): SendIO {
  return {
    exec: (cmd, args) =>
      new Promise((resolvePromise) => {
        execFile(cmd, args, { timeout: SEND_TIMEOUT_MS }, (error, stdout, stderr) => {
          const raw: unknown = error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0
          resolvePromise({
            code: typeof raw === 'number' ? raw : 1,
            out: `${stdout}${stderr}`.trim() || (error ? String(error.message ?? error) : ''),
          })
        })
      }),
  }
}

export interface SendResult {
  ok: boolean
  /** Short human-readable failure reason; empty on success. */
  detail: string
}

export async function sendSupportEmail(
  draft: SupportDraft,
  io: SendIO = realSendIO(),
  resolveAccount: () => string | undefined = resolveGmailAccount
): Promise<SendResult> {
  const gog = resolveGogBin(readEnvFile())
  const account = resolveAccount()
  const args = [
    'gmail',
    'send',
    ...(account ? ['--account', account] : []),
    '--to',
    draft.to,
    '--subject',
    draft.subject,
    '--body',
    draft.body,
  ]

  try {
    const res = await io.exec(gog, args)
    if (res.code === 0) return { ok: true, detail: '' }
    return { ok: false, detail: res.out.slice(0, 300) || `gog exited with code ${res.code}` }
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err).slice(0, 300) }
  }
}

/**
 * Fallback: persist the request locally so the user can send it themselves.
 * Returns the absolute path of the saved file.
 */
export function saveSupportRequest(
  draft: SupportDraft,
  dir: string = resolve(PROJECT_ROOT, 'support-requests')
): string {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = resolve(dir, `support-request-${stamp}.md`)
  const content = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    '',
    draft.body.trim(),
    '',
  ].join('\n')
  writeFileSync(path, content, 'utf-8')
  return path
}
