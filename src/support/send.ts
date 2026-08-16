/**
 * Delivery for a confirmed support request.
 *
 * Email goes out through the same channel the product already uses for
 * Gmail: the gog CLI (see src/infra/gog-bin.ts and the gmail skill). gog's
 * default authenticated account does the sending; no credentials pass
 * through this process. When gog is missing or the send fails — no email
 * connected is the common case — the request degrades to a local file under
 * support-requests/ so nothing the user wrote is lost.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readEnvFile, PROJECT_ROOT } from '../env.js'
import { resolveGogBin } from '../infra/gog-bin.js'
import type { SupportDraft } from './draft.js'

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
  io: SendIO = realSendIO()
): Promise<SendResult> {
  const gog = resolveGogBin(readEnvFile())
  const args = ['gmail', 'send', '--to', draft.to, '--subject', draft.subject, '--body', draft.body]

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
