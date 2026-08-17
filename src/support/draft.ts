/**
 * Assemble a support-request draft from the user's description plus
 * auto-collected diagnostics. Pure — no I/O — so the whole thing is testable.
 */

import type { SupportDiagnostics } from './diagnostics.js'
import { redactSensitive } from './redact.js'

export interface SupportDraft {
  to: string
  subject: string
  body: string
}

/**
 * Build the outgoing email. The user's description is kept verbatim (their
 * own words, deliberately written for support); the diagnostics block gets a
 * defense-in-depth redaction pass on top of the per-line one already applied
 * when the log tail was collected.
 */
export function buildSupportDraft(
  description: string,
  diagnostics: SupportDiagnostics,
  supportEmail: string
): SupportDraft {
  const skills =
    diagnostics.enabledSkillIds.length > 0 ? diagnostics.enabledSkillIds.join(', ') : '(none)'

  const logSection =
    diagnostics.errorLogTail.length > 0
      ? diagnostics.errorLogTail.map((l) => `  ${l}`).join('\n')
      : '  (no error log lines found)'

  const diagnosticsBlock = redactSensitive(
    [
      '--- Diagnostics (auto-collected, redacted) ---',
      `App version: ${diagnostics.appVersion}`,
      `OS: ${diagnostics.os}`,
      `Node: ${diagnostics.node}`,
      `Enabled skills: ${skills}`,
      `Recent error log (last ${diagnostics.errorLogTail.length} line(s)):`,
      logSection,
    ].join('\n')
  )

  return {
    to: supportEmail,
    subject: `Support request: AI Assistant v${diagnostics.appVersion}`,
    body: `${description.trim()}\n\n${diagnosticsBlock}\n`,
  }
}

/** Chat preview shown before the user confirms. */
export function formatDraftPreview(draft: SupportDraft): string {
  return [
    'Support request draft:',
    '',
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    '',
    draft.body.trim(),
    '',
    'Nothing has been sent yet.',
  ].join('\n')
}
