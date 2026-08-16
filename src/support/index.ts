export type { SupportDiagnostics, DiagnosticsIO } from './diagnostics.js'
export {
  collectDiagnostics,
  defaultDiagnosticsIO,
  extractErrorLines,
  isErrorLogLine,
  ERROR_LOG_TAIL_LINES,
} from './diagnostics.js'
export type { SupportDraft } from './draft.js'
export { buildSupportDraft, formatDraftPreview } from './draft.js'
export { redactSensitive } from './redact.js'
export type { SendIO, SendResult } from './send.js'
export { sendSupportEmail, saveSupportRequest, realSendIO } from './send.js'
