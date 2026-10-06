/**
 * Bot core: platform-agnostic message handling.
 * Receives messages via PlatformAdapter, dispatches to the Claude agent,
 * handles commands, streaming, memory, and inline buttons.
 */

import { resolve } from 'node:path'
import { writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

import { PRIMARY_CHAT_ID, TYPING_REFRESH_MS, OPENAI_API_KEY, SUPPORT_EMAIL, PUBLIC_HOSTNAME, HTTP_PORT, SHORTCUT_WAIT_SECONDS } from './config.js'
import { getSession, setSession, clearSession, getMemoriesForChat, getSessionMeta, bumpSessionMessageCount } from './db.js'
import { createTask, getAllTasks, deleteTask, pauseTask, resumeTask } from './db.js'
import { addAuthorizedChat, removeAuthorizedChat, getAuthorizedChats, isAuthorizedChat } from './db.js'
import { claimButtonClick } from './db.js'
import { decideAccess } from './access.js'
import { runAgent, steerAgent, isChatBusy, markLane, clearLane } from './agent.js'
import { saveConversationTurn } from './memory.js'
import { createDefaultEngine } from './memory/engine.js'
import { synthesizeSpeech, transcribeAudio, voiceCapabilities } from './voice.js'
import { mintVoiceLink, revokeVoiceLinks, voiceLinkMessage, voiceLinkUrl } from './voice-links.js'
import { buildPhotoMessage, buildDocumentMessage, buildVideoMessage, buildAttachmentMessage, UPLOADS_DIR } from './media.js'
import { applyReplyContext } from './prompt-safety.js'
import { extractFileMarkers } from './outbound-files.js'
import { deliverFiles, sendTextWithFiles } from './outbound-delivery.js'
import { mintShortcutToken, revokeShortcutToken, shortcutTokenInfo } from './shortcut-tokens.js'
import { SHORTCUT_TEMPLATE, shortcutSetupMessage, shortcutUrl } from './shortcut-setup.js'
import { rotationConfig, needsRotation, rotateSession } from './session-rotation.js'
import { computeNextRun } from './scheduler.js'
import { logger } from './logger.js'
import { commandWord } from './infra/command-text.js'
import { CronExpressionParser } from 'cron-parser'
import { launchChrome, stopChrome, getBrowserStatus, isCdpAvailable } from './browser.js'
import { getSkills, setSkillEnabled, reloadSkills, buildSkillIndex } from './skills/index.js'
import { checkForUpdate, applyUpdate, getCurrentVersion, getChangelog, getBootVersion, restartPending } from './updater.js'
import { canSelfRestart } from './service/supervisor.js'
import { requestRestart, rememberRestartNotice } from './infra/restart.js'
import { workingPhrase } from './working-indicator.js'
import { SecretFlow } from './secrets/flow.js'
import { PROJECT_ROOT } from './env.js'
import { interviewNudge, markInterviewOffered, shouldOfferInterview } from './onboarding/interview-offer.js'
import { workspaceCommand, workspaceCommandArgs } from './workspace/commands.js'
import { defaultSyncOne, scheduleWorkspace, unscheduleWorkspace } from './workspace/service.js'
import { makeJoinIO } from './workspace/io.js'
import {
  collectAudit,
  defaultAuditIO,
  buildAuditPrompt,
  renderDigest,
  setAuditSchedule,
  findAuditTask,
  AUDIT_SCHEDULE,
} from './audit/index.js'
import { auditScheduleDeps } from './audit/wiring.js'
import {
  collectDiagnostics,
  buildSupportDraft,
  formatDraftPreview,
  sendSupportEmail,
  saveSupportRequest,
} from './support/index.js'
import type { SupportDraft } from './support/index.js'
import type { PlatformAdapter, IncomingMessage } from './platform/types.js'
import { MEDIA_MESSAGE_TYPES } from './platform/types.js'

// Non-abort text patterns (OpenClaw v2026.5.18 -- /btw non-abort behavior).
const NON_ABORT_PATTERNS = [
  /^convolife$/i,
  /^\/schedule\s*list$/i,
  /^\/schedule$/i,
  /^\/memory$/i,
  /^\/help$/i,
  /^\/chatid$/i,
  /^\/skill\s*list$/i,
  /^\/skill$/i,
  /^\/browser\s*status$/i,
  /^\/browser$/i,
  /^\/update\s*check$/i,
  /^\/update$/i,
  /^\/version$/i,
]

function isNonAbortMessage(text: string): boolean {
  return NON_ABORT_PATTERNS.some((p) => p.test(text.trim()))
}

// Track voice mode per chat
const voiceModeChats = new Set<string>()

// Track chats we've already sent the "not authorized" reply to (avoid spam)
const unauthorizedReplied = new Set<string>()

// Initialize ContextEngine with all providers
const contextEngine = createDefaultEngine()

// /secret command state: captures pasted API keys straight into the vault,
// bypassing the model entirely (see src/secrets/flow.ts).
const secretFlow = new SecretFlow()

function isPrimaryChat(chatId: string): boolean {
  return !!PRIMARY_CHAT_ID && chatId === PRIMARY_CHAT_ID
}

function accessFor(chatId: string, text: string) {
  return decideAccess({
    chatId,
    text,
    primaryChatId: PRIMARY_CHAT_ID,
    isExtraChat: isAuthorizedChat,
  })
}

// --- Inline buttons ---
const BUTTONS_RE = /\[\[buttons:\s*([^\]]+)\]\]/i
const MAX_BUTTON_LABEL = 30

function extractButtons(text: string): { cleanText: string; labels: string[] } {
  const match = text.match(BUTTONS_RE)
  if (!match) return { cleanText: text, labels: [] }
  const labels = match[1]
    .split('|')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(0, MAX_BUTTON_LABEL))
  return { cleanText: text.replace(BUTTONS_RE, '').trim(), labels }
}

/**
 * Deliver a /secret flow reply. When the user's message held a key value it is
 * deleted from the chat first; if the platform can't delete it (Slack bots
 * can't remove user messages), the reply says so and the user cleans it up.
 */
async function sendSecretReply(
  adapter: PlatformAdapter,
  chatId: string,
  reply: string,
  opts: { deleteUserMessage?: boolean; messageId?: string }
): Promise<void> {
  let text = reply
  if (opts.deleteUserMessage) {
    const deleted =
      opts.messageId && adapter.deleteMessage
        ? await adapter.deleteMessage(chatId, opts.messageId).catch(() => false)
        : false
    if (!deleted) {
      text += '\n\nI could not delete your message from this chat. Please delete it yourself so the key does not sit in the history.'
    }
  }
  await adapter.sendMessage(chatId, text)
}

// --- Core message handling ---

async function handleMessage(
  adapter: PlatformAdapter,
  chatId: string,
  rawText: string,
  forceVoiceReply = false,
  // skipMemory: the audit feeds the assistant a report about the memory record.
  // Saving that prompt back into the record would put last month's audit into
  // next month's sample, and the month after that would audit the audit.
  opts: { skipMemory?: boolean } = {}
): Promise<void> {
  // Always-on skill catalog so the assistant knows its full toolbox and can route
  // to a skill even when the message lacks a literal trigger word. Kept as its
  // own block (not via ContextEngine) so it bypasses the "prior conversation
  // history" framing and the engine's token-budget truncation.
  const skillIndex = buildSkillIndex()

  // Build memory context via ContextEngine
  const memoryContext = await contextEngine.buildContext(chatId, rawText)

  // An install that has never run the discovery interview gets told about it
  // once, folded into this reply. The startup greeting covers platforms that
  // can open a conversation; this covers the ones that cannot, and any install
  // whose service was already running when the offer shipped.
  const offerInterview = isPrimaryChat(chatId) && shouldOfferInterview(PROJECT_ROOT)
  const onboardingNudge = offerInterview ? interviewNudge() : ''

  const fullMessage = [skillIndex, memoryContext, onboardingNudge, rawText]
    .filter(Boolean)
    .join('\n\n')

  // Session auto-rotation: retire a session that has hit its message or age
  // budget before compaction gets a chance to wreck the turn. Off unless
  // SESSION_MAX_MESSAGES / SESSION_MAX_AGE_HOURS are set.
  const rotation = rotationConfig()
  if (needsRotation(getSessionMeta(chatId), rotation)) {
    const { rotated, summary } = await rotateSession(chatId, rotation, async (prompt, oldSessionId) => {
      const { text } = await runAgent(prompt, oldSessionId)
      return text
    })
    if (rotated) {
      contextEngine.invalidateCaches()
      await adapter
        .sendMessage(chatId, summary ? 'Session rotated. Handoff summary saved to memory.' : 'Session rotated.')
        .catch(() => {})
    }
  }

  // Get existing session
  const sessionId = getSession(chatId) ?? undefined

  logger.info({ chatId, messageLength: rawText.length }, 'Processing message')

  // Start typing indicator
  const typingInterval = setInterval(() => {
    adapter.sendTyping(chatId).catch(() => {})
  }, TYPING_REFRESH_MS)
  await adapter.sendTyping(chatId).catch(() => {})

  // Streaming preview setup
  const willVoice = (forceVoiceReply || voiceModeChats.has(chatId)) && voiceCapabilities().tts
  const streamingEnabled = !willVoice && adapter.supportsEdit

  let previewMessageId: string | null = null
  const STREAM_PREVIEW_LIMIT = 3800
  const EDIT_THROTTLE_MS = 1500
  let lastEditMs = 0
  let lastRenderedPreview = ''
  let pendingEditTimer: NodeJS.Timeout | null = null
  let pendingPreviewText = ''

  async function renderPreview(text: string): Promise<void> {
    const truncated = text.length > STREAM_PREVIEW_LIMIT
    const body = truncated ? text.slice(0, STREAM_PREVIEW_LIMIT) + '\n\n... (still writing)' : text
    if (body === lastRenderedPreview) return
    lastRenderedPreview = body
    try {
      if (previewMessageId == null) {
        previewMessageId = await adapter.sendMessage(chatId, body)
      } else {
        await adapter.editMessage(chatId, previewMessageId, body)
      }
    } catch (err) {
      logger.debug({ err }, 'Preview edit skipped')
    }
  }

  function scheduleStreamEdit(accumulated: string): void {
    pendingPreviewText = accumulated
    const now = Date.now()
    const wait = Math.max(0, EDIT_THROTTLE_MS - (now - lastEditMs))
    if (pendingEditTimer) return
    pendingEditTimer = setTimeout(() => {
      pendingEditTimer = null
      lastEditMs = Date.now()
      void renderPreview(pendingPreviewText)
    }, wait)
  }

  // Mark chat lane active so cron tasks defer
  markLane(chatId, 'chat')

  try {
    const onToolProg = streamingEnabled
      ? (toolName: string, _status: string) => {
          // Human phrase, never the raw tool name (card #97): ">> Running a
          // command..." instead of ">> bash...".
          const indicator = `\n\n>> ${workingPhrase(toolName)}...`
          scheduleStreamEdit((pendingPreviewText || '') + indicator)
        }
      : undefined

    const onPartial = streamingEnabled ? scheduleStreamEdit : undefined
    const { text: response, newSessionId } = await runAgent(fullMessage, sessionId, undefined, onPartial, onToolProg)

    if (pendingEditTimer) {
      clearTimeout(pendingEditTimer)
      pendingEditTimer = null
    }

    if (newSessionId) {
      setSession(chatId, newSessionId)
    }
    bumpSessionMessageCount(chatId)

    if (!response) {
      if (previewMessageId != null) {
        await adapter.editMessage(chatId, previewMessageId, '(no response)')
      } else {
        await adapter.sendMessage(chatId, '(no response)')
      }
      return
    }

    // Save to memory
    if (!opts.skipMemory) await saveConversationTurn(chatId, rawText, response)

    // Voice reply?
    if (willVoice) {
      try {
        const audioBuffer = await synthesizeSpeech(response)
        const ext = OPENAI_API_KEY ? 'mp3' : 'm4a'
        const audioPath = resolve(UPLOADS_DIR, `tts_${Date.now()}.${ext}`)
        writeFileSync(audioPath, audioBuffer)
        await adapter.sendFile(chatId, audioPath, 'voice')
      } catch (err) {
        logger.error({ err }, 'TTS failed, sending text')
      }
    }

    // Extract inline buttons and any [[file:]] the reply asked to send
    const { cleanText: withoutButtons, labels } = extractButtons(response)
    const { cleanText, requests: fileRequests } = extractFileMarkers(withoutButtons)
    const buttonOpts = labels.length > 0 && adapter.supportsButtons ? { buttons: labels } : {}

    // Format and deliver. Empty chunks are dropped rather than sent: a reply
    // that was nothing but a [[file:]] marker leaves no text behind, and an
    // empty send is not a no-op. Teams answers 400 BadSyntax ("Activity must
    // include non empty 'text' field or at least 1 attachment"), which threw
    // past the file delivery below and lost the very file the reply was for.
    const formatted = adapter.formatText(cleanText)
    const chunks = adapter.splitMessage(formatted).filter((chunk) => chunk.trim().length > 0)
    const lastIdx = chunks.length - 1

    // A text send that fails must not take the files with it. The whole
    // point of the reply was the attachment, and the platform rejecting the
    // prose is no reason to drop it silently.
    try {
      if (chunks.length === 0) {
        // Nothing to say, something to hand over. The preview, if there is one,
        // is holding the raw marker, so it has to be replaced by something true.
        if (previewMessageId != null) {
          await adapter.editMessage(chatId, previewMessageId, fileRequests.length > 1 ? 'Sending the files.' : 'Sending the file.', {
            parseMode: 'html',
          })
        }
      } else if (previewMessageId != null) {
        // Replace streaming preview with formatted final
        const [first, ...rest] = chunks
        await adapter.editMessage(chatId, previewMessageId, first, {
          parseMode: 'html',
          ...(lastIdx === 0 ? buttonOpts : {}),
        })
        for (let i = 0; i < rest.length; i++) {
          await adapter.sendMessage(chatId, rest[i], {
            parseMode: 'html',
            ...(i + 1 === lastIdx ? buttonOpts : {}),
          })
        }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          await adapter.sendMessage(chatId, chunks[i], {
            parseMode: 'html',
            ...(i === lastIdx ? buttonOpts : {}),
          })
        }
      }

    } catch (err) {
      if (fileRequests.length === 0) throw err
      logger.error({ err, chatId }, 'sending the reply text failed; delivering the files anyway')
    }

    // Files after the text: the message says what the thing is, then the
    // thing arrives. A file that cannot be sent says so on its own line
    // rather than silently not turning up.
    if (fileRequests.length > 0) await deliverFiles(adapter, chatId, fileRequests)


    // The reply carrying the offer reached the client, so it is spent. Marked
    // here rather than at the top: a turn that throws before delivery would
    // otherwise burn the one offer this install gets.
    if (offerInterview) markInterviewOffered()
  } finally {
    if (pendingEditTimer) clearTimeout(pendingEditTimer)
    clearInterval(typingInterval)
    clearLane(chatId)
  }
}

// --- Apple Shortcuts ---

/**
 * Framing for a turn that arrived from a Shortcut. The answer lands in a small
 * panel on a phone or watch, or is read aloud by Siri, so formatting that
 * renders nicely in a chat is noise there, and a button cannot be pressed.
 */
export const SHORTCUT_FRAMING =
  '[Sent from an Apple Shortcut on the owner\'s device. The reply is shown in a small panel or read aloud by Siri: ' +
  'answer in short plain text, no Markdown, no tables, no [[buttons:]]. If something needs their approval, say so ' +
  'and they will confirm in the chat.]'

/** Whether this chat may still use the assistant. A revoked chat's Shortcut dies with it. */
export function isChatAllowed(chatId: string): boolean {
  return accessFor(chatId, '').allow
}

/**
 * One turn on behalf of a Shortcut, in the chat's own session.
 *
 * The chat's session rather than one of its own, which is the point: ask from
 * Siri in the car, then pick it up in the chat at your desk and the assistant
 * knows what you were talking about. That also means it must never run beside
 * a turn already going in that chat (two runs resuming one session corrupt
 * it), so the caller checks isChatBusy first, and this marks the lane so a
 * chat message arriving mid-turn sees it busy too.
 *
 * Returns the raw reply, markers included: what to do with buttons and files
 * depends on whether the Shortcut is still waiting, which only the caller
 * knows.
 */
export async function runShortcutTurn(chatId: string, rawText: string): Promise<string | null> {
  markLane(chatId, 'chat')
  try {
    const skillIndex = buildSkillIndex()
    const memoryContext = await contextEngine.buildContext(chatId, rawText)
    const fullMessage = [skillIndex, memoryContext, SHORTCUT_FRAMING, rawText].filter(Boolean).join('\n\n')
    const sessionId = getSession(chatId) ?? undefined
    logger.info({ chatId, messageLength: rawText.length }, 'Processing shortcut message')
    const { text, newSessionId } = await runAgent(fullMessage, sessionId)
    if (newSessionId) setSession(chatId, newSessionId)
    bumpSessionMessageCount(chatId)
    if (text) await saveConversationTurn(chatId, rawText, text)
    return text
  } finally {
    clearLane(chatId)
  }
}

/**
 * Put text (and any [[file:]] it carries) into a chat from outside a chat
 * turn: the voice handoff, a Shortcut answer that outran the phone. Null
 * until createBot has run, and callers treat that as "nowhere to send it".
 */
let boundAdapter: PlatformAdapter | null = null

export async function deliverToChat(chatId: string, text: string): Promise<boolean> {
  if (!boundAdapter) return false
  await sendTextWithFiles(boundAdapter, chatId, text)
  return true
}

// --- Command handlers ---

async function handleScheduleCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const tasks = getAllTasks()
    if (tasks.length === 0) {
      await adapter.sendMessage(chatId, 'No scheduled tasks.')
      return
    }
    const lines = tasks.map((t) => {
      const label = t.name ?? t.prompt.slice(0, 60)
      const mode = t.delivery_mode === 'silent' ? ' [silent]' : ''
      return `[${t.status}${mode}] ${t.id}: ${label}\nSchedule: ${t.schedule} | Next: ${new Date(t.next_run * 1000).toLocaleString()}`
    })
    await adapter.sendMessage(chatId, lines.join('\n\n'))
    return
  }

  if (subcmd === 'create') {
    const match = text.match(/create\s+"([^"]+)"\s+"([^"]+)"/)
    if (!match) {
      await adapter.sendMessage(chatId, 'Usage: /schedule create "prompt" "cron" [--name "name"] [--silent]')
      return
    }
    const [, prompt, cron] = match
    try {
      CronExpressionParser.parse(cron)
    } catch {
      await adapter.sendMessage(chatId, `Invalid cron expression: ${cron}`)
      return
    }
    const nameMatch = text.match(/--name\s+"([^"]+)"/)
    const name = nameMatch?.[1] ?? null
    const isSilent = text.includes('--silent')
    const deliveryMode = isSilent ? 'silent' as const : 'announce' as const

    const id = randomUUID().slice(0, 8)
    const env = (await import('./env.js')).readEnvFile()
    const tz = env['TIMEZONE'] ?? 'America/New_York'
    const nextRun = computeNextRun(cron, tz)
    createTask(id, chatId, prompt, cron, nextRun, name ?? undefined, deliveryMode, tz)
    await adapter.sendMessage(
      chatId,
      `Task created: ${id}${name ? ` (${name})` : ''}\nMode: ${deliveryMode}\nSchedule: ${cron}\nNext run: ${new Date(nextRun * 1000).toLocaleString()}`
    )
    return
  }

  if (subcmd === 'delete') {
    const id = parts[2]
    if (!id) { await adapter.sendMessage(chatId, 'Usage: /schedule delete <id>'); return }
    await adapter.sendMessage(chatId, deleteTask(id) ? `Task ${id} deleted.` : `Task ${id} not found.`)
    return
  }

  if (subcmd === 'pause') {
    const id = parts[2]
    if (!id) { await adapter.sendMessage(chatId, 'Usage: /schedule pause <id>'); return }
    await adapter.sendMessage(chatId, pauseTask(id) ? `Task ${id} paused.` : `Task ${id} not found.`)
    return
  }

  if (subcmd === 'resume') {
    const id = parts[2]
    if (!id) { await adapter.sendMessage(chatId, 'Usage: /schedule resume <id>'); return }
    const tasks = getAllTasks()
    const task = tasks.find((t) => t.id === id)
    if (!task) { await adapter.sendMessage(chatId, `Task ${id} not found.`); return }
    const nextRun = computeNextRun(task.schedule)
    if (resumeTask(id, nextRun)) {
      await adapter.sendMessage(chatId, `Task ${id} resumed. Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    } else {
      await adapter.sendMessage(chatId, `Failed to resume task ${id}.`)
    }
    return
  }

  await adapter.sendMessage(chatId, 'Unknown schedule command. Use: list, create, delete, pause, resume')
}

async function handleBrowserCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'status') {
    const status = await getBrowserStatus()
    await adapter.sendMessage(chatId, status)
    return
  }

  if (subcmd === 'start') {
    const already = await isCdpAvailable()
    if (already) {
      await adapter.sendMessage(chatId, 'Chrome CDP is already running on port 9222.')
      return
    }
    const useDefault = text.includes('--default')
    const ok = launchChrome({ useDefaultProfile: useDefault })
    if (ok) {
      const mode = useDefault ? 'default profile (your logins)' : 'isolated profile'
      await adapter.sendMessage(chatId, `Chrome launched with CDP on port 9222 (${mode}).`)
    } else {
      await adapter.sendMessage(chatId, 'Failed to launch Chrome. Check logs.')
    }
    return
  }

  if (subcmd === 'stop') {
    const stopped = stopChrome()
    await adapter.sendMessage(chatId, stopped ? 'Chrome CDP stopped.' : 'No Chrome CDP instance found to stop.')
    return
  }

  await adapter.sendMessage(chatId, 'Usage: /browser [start|stop|status]\n  --default: use your real Chrome profile')
}

/**
 * Send a body of text that may be longer than the platform allows.
 *
 * handleMessage does this inline for an agent reply. Anything else that can
 * produce a long body needs it too: a platform does not truncate an oversized
 * message, it rejects the send, so the user gets nothing at all. /audit digest
 * quotes up to 60 turns and lands near 11,000 characters on a busy box,
 * against Telegram's 4096 and Teams' 8000.
 */
export async function deliverText(
  adapter: PlatformAdapter,
  chatId: string,
  body: string
): Promise<void> {
  for (const chunk of adapter.splitMessage(adapter.formatText(body))) {
    await adapter.sendMessage(chatId, chunk)
  }
}

/**
 * Send a fixed-width block as code, in pieces that each stand on their own.
 *
 * Fencing first and splitting afterwards is the obvious order and the wrong
 * one: the opening fence lands in the first chunk and the closing fence in the
 * last, so every chunk in between renders as prose or as literal backticks.
 * So the body is split first, on a budget that leaves room for the fence, and
 * each piece is wrapped on its own.
 */
export async function deliverFenced(
  adapter: PlatformAdapter,
  chatId: string,
  body: string
): Promise<void> {
  const FENCE_OVERHEAD = 8 // ```\n ... \n```
  const budget = Math.max(1, adapter.maxMessageLength - FENCE_OVERHEAD)
  for (let i = 0; i < body.length; i += budget) {
    await adapter.sendMessage(chatId, `\`\`\`\n${body.slice(i, i + budget)}\n\`\`\``)
  }
}

/**
 * `/audit` reviews how this chat has actually been using its assistant.
 *
 * The numbers come from the box's own records (src/audit/digest.ts) and the
 * reading of them comes from the assistant. Feeding it through handleMessage
 * rather than runAgent buys streaming, formatting and message splitting for
 * free; skipMemory keeps the audit out of the record it audits.
 *
 * `/audit digest` prints the raw facts with no model in the loop, which is the
 * only way for an owner to check that the report was not embroidered.
 */
async function handleAuditCommand(
  adapter: PlatformAdapter,
  chatId: string,
  text: string
): Promise<void> {
  const args = text.split(/\s+/).slice(1).map((w) => w.toLowerCase())

  if (args[0] === 'monthly') {
    const deps = auditScheduleDeps()
    if (args[1] === 'on' || args[1] === 'off') {
      const result = setAuditSchedule(chatId, args[1] === 'on', deps)
      const replies: Record<string, string> = {
        created: `Monthly audit scheduled: ${AUDIT_SCHEDULE} (9am on the 1st). Send /audit any time for one now.`,
        exists: 'The monthly audit is already scheduled.',
        removed: 'Monthly audit turned off. /audit still works on demand.',
        absent: 'The monthly audit was not scheduled.',
      }
      await adapter.sendMessage(chatId, replies[result] ?? result)
      return
    }
    const existing = findAuditTask(chatId, deps)
    await adapter.sendMessage(
      chatId,
      existing
        ? `Monthly audit is on (${existing.schedule}). Send /audit monthly off to stop it.`
        : 'Monthly audit is off. Send /audit monthly on to schedule it for the 1st of each month.'
    )
    return
  }

  if (args.length > 0 && args[0] !== 'digest') {
    await adapter.sendMessage(chatId, 'Usage: /audit, /audit digest (raw numbers), /audit monthly on|off')
    return
  }

  let digest
  try {
    digest = collectAudit(chatId, defaultAuditIO())
  } catch (err) {
    logger.error({ err, chatId }, 'Audit digest failed')
    await adapter.sendMessage(chatId, 'Could not read the usage records for this chat.')
    return
  }

  if (args[0] === 'digest') {
    // Fenced: the digest is a fixed-width block whose columns and indentation
    // are the point. Every adapter turns a fence into its own monospace form
    // (Teams leaves it alone, Telegram makes it a pre block), and without one
    // Teams collapses the single newlines into a paragraph.
    await deliverFenced(adapter, chatId, renderDigest(digest))
    return
  }

  await handleMessage(adapter, chatId, buildAuditPrompt(digest), false, { skipMemory: true })
}

/**
 * `/voice ui` mints this chat's own link to the voice page. The operator never
 * handles it: previously the only way in was HTTP_BEARER_TOKEN pasted into a
 * URL, which meant whoever set the box up held a working key to every user's
 * assistant. See src/voice-links.ts.
 */
async function handleVoiceUiCommand(
  adapter: PlatformAdapter,
  chatId: string,
  action: string | undefined
): Promise<void> {
  if (action === 'revoke') {
    const n = revokeVoiceLinks(chatId)
    await adapter.sendMessage(
      chatId,
      n > 0
        ? 'Voice link revoked, and any browser signed in with it is signed out.'
        : 'No active voice link to revoke.'
    )
    return
  }
  if (action) {
    await adapter.sendMessage(chatId, 'Usage: /voice ui, or /voice ui revoke')
    return
  }
  if (!PUBLIC_HOSTNAME) {
    await adapter.sendMessage(
      chatId,
      [
        'This box has no public address, so there is no voice page to link to.',
        '',
        'Operator: run',
        '  sudo node dist/scripts/hosted/enable-teams.js <hostname> --voice',
        'then restart the service.',
      ].join('\n')
    )
    return
  }
  const link = mintVoiceLink(chatId)
  const parts = [voiceLinkMessage(voiceLinkUrl(PUBLIC_HOSTNAME, link.token), link.expiresAt)]
  if (!voiceCapabilities().stt) {
    parts.push('', 'Heads up: speech-to-text is off (no OPENAI_API_KEY), so the page will only accept typed input.')
  }
  await adapter.sendMessage(chatId, parts.join('\n'))
}

/**
 * `/shortcut` mints this chat's Apple Shortcuts key and explains how to use
 * it. See src/shortcut-tokens.ts for why it does not expire.
 */
async function handleShortcutCommand(
  adapter: PlatformAdapter,
  chatId: string,
  text: string,
  isPrivate: boolean | undefined
): Promise<void> {
  // Private chats only, status and revoke included. In a group the key would
  // be posted where every member can read it and use it as that chat, and any
  // member could replace or revoke it. Unknown counts as a group.
  if (isPrivate !== true) {
    await adapter.sendMessage(chatId, 'Shortcut keys are only handed out in a one-to-one chat with me. Send /shortcut there.')
    return
  }
  const action = text.trim().split(/\s+/)[1]?.toLowerCase()
  if (action === 'revoke') {
    await adapter.sendMessage(
      chatId,
      revokeShortcutToken(chatId) ? 'Shortcut key revoked. Any shortcut using it stops working now.' : 'No shortcut key to revoke.'
    )
    return
  }
  if (action === 'status') {
    const info = shortcutTokenInfo(chatId)
    const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    await adapter.sendMessage(
      chatId,
      info
        ? `Shortcut key made ${when(info.createdAt)}, ${info.lastUsedAt ? `last used ${when(info.lastUsedAt)}` : 'never used yet'}.`
        : 'No shortcut key. Send /shortcut to make one.'
    )
    return
  }
  if (action) {
    await adapter.sendMessage(chatId, 'Usage: /shortcut (set up), /shortcut status, /shortcut revoke')
    return
  }
  const target = shortcutUrl(PUBLIC_HOSTNAME, HTTP_PORT)
  if (!target) {
    await adapter.sendMessage(chatId, 'I could not find an address a phone could reach me on, so there is nothing to point a shortcut at yet.')
    return
  }
  const token = mintShortcutToken(chatId)
  // The file first, so "the file above" is true. A platform that cannot send
  // it still gets a working setup: the message falls back to building it by
  // hand.
  let sentFile = false
  const template = resolve(PROJECT_ROOT, SHORTCUT_TEMPLATE)
  if (existsSync(template)) {
    try {
      await adapter.sendFile(chatId, template, 'document')
      sentFile = true
    } catch (err) {
      logger.warn({ err }, 'could not send the shortcut file; sending by-hand steps')
    }
  }
  await adapter.sendMessage(chatId, shortcutSetupMessage(target.reach, SHORTCUT_WAIT_SECONDS, sentFile))
  await adapter.sendMessage(chatId, target.url)
  // As code: base64url has underscores, and Teams renders every message as
  // Markdown, so a bare key could come out italicised with characters missing.
  await adapter.sendMessage(chatId, adapter.formatText('`Bearer ' + token + '`'), { parseMode: 'html' })
}

async function handleSkillCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const skills = getSkills()
    if (skills.length === 0) {
      await adapter.sendMessage(chatId, 'No skills installed.\nDrop folders into skills/')
      return
    }
    const lines = skills.map(s => {
      const status = s.manifest.enabled ? '\u2713' : '\u2717'
      const triggers = s.manifest.triggers.slice(0, 5).join(', ')
      return `${status} ${s.manifest.name} (${s.manifest.id})\n  Triggers: ${triggers}\n  Priority: ${s.manifest.priority ?? 50}`
    })
    await adapter.sendMessage(chatId, lines.join('\n\n'))
    return
  }

  if (subcmd === 'enable' || subcmd === 'disable') {
    const id = parts[2]
    if (!id) {
      await adapter.sendMessage(chatId, `Usage: /skill ${subcmd} <id>`)
      return
    }
    const ok = setSkillEnabled(id, subcmd === 'enable')
    await adapter.sendMessage(chatId, ok ? `Skill ${id} ${subcmd}d.` : `Skill ${id} not found.`)
    return
  }

  if (subcmd === 'reload') {
    const skills = reloadSkills()
    await adapter.sendMessage(chatId, `Reloaded ${skills.length} skill(s).`)
    return
  }

  await adapter.sendMessage(chatId, 'Usage: /skill [list|enable|disable|reload]')
}

async function handleAuthorizeCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  if (!isPrimaryChat(chatId)) {
    await adapter.sendMessage(chatId, 'Only the primary chat can manage authorized chats.')
    return
  }

  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const chats = getAuthorizedChats()
    if (chats.length === 0) {
      await adapter.sendMessage(chatId, 'No additional chats authorized. Only the primary chat is active.')
      return
    }
    const lines = chats.map((c) => {
      const label = c.label ? ` (${c.label})` : ''
      return `${c.chat_id}${label} - added ${new Date(c.created_at * 1000).toLocaleDateString()}`
    })
    await adapter.sendMessage(chatId, `Authorized chats:\n${lines.join('\n')}`)
    return
  }

  if (subcmd === 'add') {
    const targetId = parts[2]
    if (!targetId) {
      await adapter.sendMessage(chatId, 'Usage: /authorize add <chat_id> [label]')
      return
    }
    const label = parts.slice(3).join(' ') || null
    addAuthorizedChat(targetId, label, chatId)
    unauthorizedReplied.delete(targetId)
    await adapter.sendMessage(chatId, `Chat ${targetId} authorized.${label ? ` Label: ${label}` : ''}`)
    return
  }

  if (subcmd === 'remove') {
    const targetId = parts[2]
    if (!targetId) {
      await adapter.sendMessage(chatId, 'Usage: /authorize remove <chat_id>')
      return
    }
    const removed = removeAuthorizedChat(targetId)
    await adapter.sendMessage(chatId, removed ? `Chat ${targetId} deauthorized.` : `Chat ${targetId} was not authorized.`)
    return
  }

  await adapter.sendMessage(chatId, 'Usage: /authorize [add|remove|list]')
}

async function handleWorkspaceCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  if (!isPrimaryChat(chatId)) {
    await adapter.sendMessage(chatId, 'Only the primary chat can manage workspaces.')
    return
  }
  const notify = async (t: string): Promise<void> => { await adapter.sendMessage(chatId, t) }
  const reply = await workspaceCommand(workspaceCommandArgs(text), {
    joinIO: makeJoinIO(),
    notify,
    schedule: (entry) => scheduleWorkspace(entry, { syncOne: defaultSyncOne, notify }),
    unschedule: unscheduleWorkspace,
  })
  await adapter.sendMessage(chatId, reply)
}

// --- Support requests (/support) ---
// A drafted request waits here until the user confirms via the Send / Edit /
// Discard buttons (or types one of those words on platforms without buttons).
// Nothing is ever sent without that explicit confirmation.
const pendingSupport = new Map<string, SupportDraft>()
// Chats where a bare /support (or Edit) is waiting for the problem description.
const awaitingSupportDescription = new Set<string>()

async function draftSupportRequest(
  adapter: PlatformAdapter,
  chatId: string,
  description: string
): Promise<void> {
  awaitingSupportDescription.delete(chatId)
  const diagnostics = collectDiagnostics()
  const draft = buildSupportDraft(description, diagnostics, SUPPORT_EMAIL)
  pendingSupport.set(chatId, draft)

  const preview = formatDraftPreview(draft)
  if (adapter.supportsButtons) {
    await adapter.sendMessage(chatId, preview, { buttons: ['Send', 'Edit', 'Discard'] })
  } else {
    await adapter.sendMessage(chatId, `${preview}\n\nReply Send, Edit, or Discard.`)
  }
}

async function handleSupportCommand(
  adapter: PlatformAdapter,
  chatId: string,
  text: string
): Promise<void> {
  const description = text.replace(/^\/support\s*/i, '').trim()
  if (!description) {
    pendingSupport.delete(chatId)
    awaitingSupportDescription.add(chatId)
    await adapter.sendMessage(
      chatId,
      "What's going wrong? Describe the problem in your next message and I'll draft a support request.\n(Or skip this step next time with /support <description>.)"
    )
    return
  }
  await draftSupportRequest(adapter, chatId, description)
}

/**
 * Resolve a Send / Edit / Discard action on a pending support draft.
 * Returns false when there is no pending draft or the action is unrelated,
 * so the caller can fall through to normal routing.
 */
async function resolveSupportAction(
  adapter: PlatformAdapter,
  chatId: string,
  action: string
): Promise<boolean> {
  const draft = pendingSupport.get(chatId)
  if (!draft) return false

  const normalized = action.trim().toLowerCase()

  if (normalized === 'send') {
    pendingSupport.delete(chatId)
    const result = await sendSupportEmail(draft)
    if (result.ok) {
      await adapter.sendMessage(chatId, `Support request sent to ${draft.to}.`)
      return true
    }
    // No email connected (or gog missing/failing): keep the request locally.
    try {
      const path = saveSupportRequest(draft)
      await adapter.sendMessage(
        chatId,
        `Couldn't send the email (${result.detail || 'no email account connected'}).\n` +
          `Saved the request to:\n${path}\nSend it manually to ${draft.to} when you can.`
      )
    } catch (err) {
      logger.error({ err }, 'Failed to save support request fallback file')
      await adapter.sendMessage(
        chatId,
        `Couldn't send the email and couldn't save it locally either. Please email ${draft.to} directly.`
      )
    }
    return true
  }

  if (normalized === 'edit') {
    pendingSupport.delete(chatId)
    awaitingSupportDescription.add(chatId)
    await adapter.sendMessage(chatId, 'Draft dropped. Send the revised description as your next message.')
    return true
  }

  if (normalized === 'discard') {
    pendingSupport.delete(chatId)
    await adapter.sendMessage(chatId, 'Support request discarded. Nothing was sent.')
    return true
  }

  return false
}

// Track pending update confirmations
const pendingUpdateConfirm = new Set<string>()

async function handleUpdateCommand(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'check') {
    const status = await checkForUpdate(false)
    if (status.error) {
      let errMsg = `Update check failed: ${status.error}`
      if (status.error.includes('404') && !process.env.GITHUB_TOKEN) {
        errMsg += '\n\nThe repo is private. Add GITHUB_TOKEN to your .env (a fine-grained PAT with Contents read access).'
      }
      await adapter.sendMessage(chatId, errMsg)
      return
    }
    if (status.updateAvailable && status.latestVersion) {
      const changelog = await getChangelog(status.latestVersion)
      let msg = `Update available: v${status.currentVersion} -> v${status.latestVersion}`
      if (changelog) {
        msg += `\n\n${changelog.slice(0, 800)}`
      } else {
        msg += `\n\nRelease notes: https://github.com/lefebma/ai-assistant-starter/releases/tag/v${status.latestVersion}`
      }
      msg += '\n\nRun /update apply to install.'
      await adapter.sendMessage(chatId, msg)
    } else if (restartPending()) {
      // "You're on the latest version" is true of the files and false of the
      // process, and the difference is the whole reason the last update has
      // not taken effect.
      await adapter.sendMessage(
        chatId,
        `v${status.currentVersion} is installed, but this process is still running v${getBootVersion()}.\n` +
        'Restart the service to pick it up.'
      )
    } else {
      await adapter.sendMessage(chatId, `You're on the latest version (v${status.currentVersion}).`)
    }
    return
  }

  if (subcmd === 'apply') {
    // Require confirmation for the primary chat, auto-allow for direct re-confirm
    if (!pendingUpdateConfirm.has(chatId)) {
      pendingUpdateConfirm.add(chatId)
      const status = await checkForUpdate(true)
      if (!status.updateAvailable) {
        pendingUpdateConfirm.delete(chatId)
        await adapter.sendMessage(chatId, `Already on latest version (v${status.currentVersion}).`)
        return
      }
      await adapter.sendMessage(
        chatId,
        `This will update the engine from v${status.currentVersion} to v${status.latestVersion}.\n` +
        'Your .env, CLAUDE.md, PERSONALITY.md, skills, and data are preserved.\n' +
        (canSelfRestart()
          ? 'I restart myself when it is done and go quiet for a minute or so.\n\n'
          : 'The service will need a restart after.\n\n') +
        'Run /update apply again to confirm.'
      )
      // Auto-expire confirmation after 2 minutes
      setTimeout(() => pendingUpdateConfirm.delete(chatId), 120_000)
      return
    }

    pendingUpdateConfirm.delete(chatId)
    await adapter.sendMessage(chatId, 'Downloading and applying update... this may take a minute.')

    const result = await applyUpdate()

    // New files under a running process do nothing until it restarts, and on a
    // hosted box the client has no terminal to do that from. Where a supervisor
    // will bring us back, take the restart rather than leaving an instruction
    // nobody can act on. Where one will not, exiting would end the assistant,
    // so say what has to happen instead.
    if (result.success && canSelfRestart()) {
      // Do not invite a message into the gap. On a webhook platform the process
      // being down is not a delay, it is a lost message: Teams pushes once, the
      // edge answers 502 with nothing behind it, and that turn never happens.
      // So ask them to wait, and speak first when we are back (see index.ts).
      rememberRestartNotice({ chatId, toVersion: result.toVersion })
      await adapter.sendMessage(
        chatId,
        `Updated from v${result.fromVersion} to v${result.toVersion}.\n` +
        'Restarting now. Anything you send in the next minute will not reach me, so hold on and I will tell you when I am back.'
      )
      requestRestart()
      logger.info({ to: result.toVersion }, 'Restarting to activate the update')
      process.kill(process.pid, 'SIGTERM')
      return
    }

    await adapter.sendMessage(chatId, result.message)
    return
  }

  await adapter.sendMessage(chatId, 'Usage: /update [check|apply]')
}

// --- Bot creation ---

export interface BotCore {
  registerCommands(): Promise<void>
}

export function createBot(adapter: PlatformAdapter): BotCore {
  boundAdapter = adapter
  // Route incoming messages to the right handler
  adapter.onMessage(async (msg: IncomingMessage) => {
    const { chatId, text, type } = msg

    // Authorization check. An install with no ALLOWED_CHAT_ID answers only the
    // handful of commands needed to finish setting itself up; see src/access.ts.
    const access = accessFor(chatId, typeof text === 'string' ? text : '')
    if (!access.allow) {
      logger.warn({ chatId, configured: !!PRIMARY_CHAT_ID }, 'Unauthorized message')
      if (!unauthorizedReplied.has(chatId)) {
        unauthorizedReplied.add(chatId)
        if (access.reply) await adapter.sendMessage(chatId, access.reply)
      }
      return
    }

    // Handle callbacks (button clicks)
    if (type === 'callback') {
      const data = msg.callbackData ?? ''
      if (!data.startsWith('btn:')) return
      const label = data.slice(4)
      // Claim the card's one allowed click BEFORE doing anything with it.
      // Clearing the keyboard is a visual change the client may not apply
      // (Teams desktop ignores the edit and leaves the buttons live), so it
      // cannot be what stops a second click on a card that sends an email.
      if (msg.messageId) {
        const claim = claimButtonClick(chatId, msg.messageId, label)
        if (!claim.claimed) {
          const already =
            claim.existingLabel && claim.existingLabel !== label
              ? `Already answered that one with "${claim.existingLabel}", so I ignored "${label}".`
              : `Already handled "${label}" on that one.`
          await adapter.sendMessage(chatId, already)
          return
        }
      }
      // Clear the keyboard
      if (msg.messageId) {
        await adapter.clearButtons(chatId, msg.messageId)
      }
      // A pending support draft owns its Send/Edit/Discard buttons; resolve it
      // here rather than routing the click through the agent.
      if (await resolveSupportAction(adapter, chatId, label)) return
      await handleMessage(adapter, chatId, `[button_click]: ${label}`)
      return
    }

    // Handle media. While a /secret set is pending, media replies are refused
    // rather than routed to the model: a voice note or caption sent mid-flow
    // could carry the key, and transcripts/captions must never reach the agent
    // in that window.
    if (secretFlow.hasPending(chatId) && (MEDIA_MESSAGE_TYPES as readonly string[]).includes(type)) {
      await adapter.sendMessage(chatId, 'I am waiting for a secret value. Send it as a plain text message, or /secret cancel.')
      return
    }
    if (type === 'voice' && msg.filePath) {
      if (!voiceCapabilities().stt) {
        await adapter.sendMessage(chatId, 'Voice transcription is not enabled. Add OPENAI_API_KEY to .env.')
        return
      }
      try {
        const transcript = await transcribeAudio(msg.filePath)
        if (!transcript.trim()) {
          await adapter.sendMessage(chatId, 'Could not transcribe audio.')
          return
        }
        await handleMessage(adapter, chatId, `[Voice message transcription]: ${transcript}`, true)
      } catch (err) {
        logger.error({ err }, 'Voice transcription failed')
        await adapter.sendMessage(chatId, 'Failed to transcribe voice message.')
      }
      return
    }

    if (type === 'photo' && msg.filePath) {
      const message = buildPhotoMessage(msg.filePath, msg.caption)
      await handleMessage(adapter, chatId, applyReplyContext(msg.replyContext, message))
      return
    }

    if (type === 'document' && msg.filePath) {
      const message = buildDocumentMessage(msg.filePath, msg.fileName ?? 'document', msg.caption)
      await handleMessage(adapter, chatId, applyReplyContext(msg.replyContext, message))
      return
    }

    if (type === 'video' && msg.filePath) {
      const message = buildVideoMessage(msg.filePath, msg.caption)
      await handleMessage(adapter, chatId, applyReplyContext(msg.replyContext, message))
      return
    }

    if ((type === 'audio' || type === 'animation' || type === 'sticker' || type === 'video_note') && msg.filePath) {
      const message = buildAttachmentMessage(type, msg.filePath, msg.caption, msg.fileName)
      await handleMessage(adapter, chatId, applyReplyContext(msg.replyContext, message))
      return
    }

    // Text messages: route commands. `cmd` is the leading word, lowercased;
    // handlers still receive `trimmed` so argument case survives.
    const trimmed = text.trim()
    const cmd = commandWord(trimmed)

    // A pending /secret set owns the next text message: capture it in code,
    // delete it from the chat, never let it near the model. This must run
    // before the busy check and the support flow — the capture touches
    // nothing but the vault. capture() is the single gate (it also owns the
    // expired case, where the late message probably IS a key and still needs
    // deleting). A command other than /secret cancels the capture instead,
    // so stale state can't swallow unrelated commands.
    if (!trimmed.startsWith('/')) {
      const captured = await secretFlow.capture(chatId, trimmed)
      if (captured) {
        await sendSecretReply(adapter, chatId, captured.reply, {
          deleteUserMessage: captured.deleteUserMessage,
          messageId: msg.messageId,
        })
        return
      }
    } else if (cmd !== '/secret' && secretFlow.cancelPending(chatId)) {
      await adapter.sendMessage(chatId, 'Pending /secret set cancelled.')
    }

    // /btw non-abort: read-only commands during active run
    if (isChatBusy(chatId) && isNonAbortMessage(trimmed)) {
      logger.info({ chatId, text: trimmed.slice(0, 40) }, 'Non-abort command during active run')
      await adapter.sendMessage(chatId, 'Agent is busy. That command will work once the current task finishes.')
      return
    }

    // Support flow: a typed Send/Edit/Discard resolves a pending draft
    // (platforms without buttons), and the message after a bare /support
    // (or Edit) is the problem description.
    if (pendingSupport.has(chatId) && /^(send|edit|discard)$/i.test(trimmed)) {
      if (await resolveSupportAction(adapter, chatId, trimmed)) return
    }
    if (awaitingSupportDescription.has(chatId) && !trimmed.startsWith('/')) {
      await draftSupportRequest(adapter, chatId, trimmed)
      return
    }

    // Command routing. The log line is the only trace a command leaves at
    // info level (agent-bound messages log "Processing message" instead);
    // without it a handled command is indistinguishable from a dropped one.
    if (trimmed.startsWith('/')) {
      logger.info({ chatId, command: cmd }, 'Handling command')
    }
    if (cmd === '/start') {
      await adapter.sendMessage(chatId, 'AI Assistant is running. Send me anything and I\'ll process it with Claude Code.')
      return
    }
    if (cmd === '/chatid') {
      await adapter.sendMessage(chatId, `Your chat ID is: ${chatId}`)
      return
    }
    if (cmd === '/newchat' || cmd === '/forget') {
      clearSession(chatId)
      reloadSkills()
      contextEngine.invalidateCaches()
      pendingSupport.delete(chatId)
      awaitingSupportDescription.delete(chatId)
      await adapter.sendMessage(chatId, 'Session cleared. Starting fresh.')
      return
    }
    if (cmd === '/voice') {
      const sub = trimmed.split(/\s+/).slice(1).map((w) => w.toLowerCase())
      if (sub[0] === 'ui') {
        await handleVoiceUiCommand(adapter, chatId, sub[1])
        return
      }
      if (sub.length > 0) {
        await adapter.sendMessage(chatId, 'Usage: /voice (toggle voice replies), /voice ui (link to the voice chat page), /voice ui revoke')
        return
      }
      if (voiceModeChats.has(chatId)) {
        voiceModeChats.delete(chatId)
        await adapter.sendMessage(chatId, 'Voice replies disabled.')
      } else {
        if (!voiceCapabilities().tts) {
          await adapter.sendMessage(chatId, 'TTS not configured. Set OPENAI_API_KEY in .env')
          return
        }
        voiceModeChats.add(chatId)
        await adapter.sendMessage(chatId, 'Voice replies enabled. Send /voice again to disable.')
      }
      return
    }
    if (cmd === '/shortcut') {
      await handleShortcutCommand(adapter, chatId, trimmed, msg.isPrivate)
      return
    }
    if (cmd === '/memory') {
      const memories = getMemoriesForChat(chatId, 10)
      if (memories.length === 0) {
        await adapter.sendMessage(chatId, 'No memories stored yet.')
      } else {
        const lines = memories.map(
          (m) => `[${m.sector}] (${m.salience.toFixed(2)}) ${m.content.slice(0, 100)}`
        )
        await adapter.sendMessage(chatId, `Recent memories:\n\n${lines.join('\n')}`)
      }
      return
    }
    if (cmd === '/schedule') {
      await handleScheduleCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/dashboard') {
      const dashSubcmd = trimmed.split(/\s+/)[1]?.toLowerCase()
      const plist = resolve(homedir(), 'Library/LaunchAgents/com.ai-assistant.dashboard.plist')
      if (dashSubcmd === 'start') {
        try {
          execFileSync('launchctl', ['load', plist], { stdio: 'ignore' })
          await adapter.sendMessage(chatId, 'Dashboard data API started on port 3002.')
        } catch {
          await adapter.sendMessage(chatId, 'Failed to start dashboard. Check the plist exists.')
        }
      } else if (dashSubcmd === 'stop') {
        try {
          execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' })
          await adapter.sendMessage(chatId, 'Dashboard service stopped.')
        } catch {
          await adapter.sendMessage(chatId, 'Failed to stop dashboard.')
        }
      } else {
        await adapter.sendMessage(chatId, 'Dashboard: /dashboard start, /dashboard stop')
      }
      return
    }
    if (cmd === '/browser') {
      await handleBrowserCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/steer') {
      const steerText = trimmed.replace(/^\/steer\s*/i, '').trim()
      if (!steerText) {
        await adapter.sendMessage(chatId, 'Usage: /steer <message>\nInjects a steering message into the currently running agent.')
        return
      }
      steerAgent(steerText)
      await adapter.sendMessage(chatId, `Steer queued: "${steerText.slice(0, 80)}${steerText.length > 80 ? '...' : ''}"`)
      return
    }
    if (cmd === '/skill') {
      await handleSkillCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/secret') {
      if (!isPrimaryChat(chatId)) {
        // An inline `/secret set NAME value` from a non-primary chat still
        // holds a key — delete it even though the command is refused.
        await sendSecretReply(adapter, chatId, 'Only the primary chat can manage secrets.', {
          deleteUserMessage: trimmed.split(/\s+/).length > 3,
          messageId: msg.messageId,
        })
        return
      }
      const outcome = await secretFlow.handleCommand(chatId, trimmed)
      await sendSecretReply(adapter, chatId, outcome.reply, {
        deleteUserMessage: outcome.deleteUserMessage,
        messageId: msg.messageId,
      })
      return
    }
    if (cmd === '/authorize') {
      await handleAuthorizeCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/workspace') {
      await handleWorkspaceCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/support') {
      await handleSupportCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/version') {
      // Report what is running, not what is on disk. Those differ for exactly
      // as long as an applied update waits for a restart, which is the window
      // where someone is most likely to be asking.
      const msg = restartPending()
        ? `AI Assistant v${getBootVersion()} (running)\n` +
          `v${getCurrentVersion()} is installed and starts on the next restart.`
        : `AI Assistant v${getBootVersion()}`
      await adapter.sendMessage(chatId, msg)
      return
    }
    if (cmd === '/update') {
      await handleUpdateCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/audit') {
      await handleAuditCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/help') {
      await adapter.sendMessage(chatId, [
        'Commands:',
        '/newchat - Clear session, start fresh',
        '/memory - Show stored memories',
        '/voice - Toggle voice replies',
        '/voice ui - Get your private link to the voice chat page',
        '/shortcut - Talk to me from Siri and Apple Shortcuts (status/revoke)',
        '/schedule - Manage scheduled tasks',
        '/dashboard - Dashboard (start/stop)',
        '/browser - Chrome CDP (start/stop/status)',
        '/steer - Inject mid-run steering message',
        '/skill - Manage skills (list/enable/disable/reload)',
        '/secret - Manage API keys in the encrypted vault (set/list/rm)',
        '/authorize - Manage multi-chat access (add/remove/list)',
        '/workspace - Shared workspaces (join/status/sync/leave, primary only)',
        '/audit - Review how you have been using the assistant (monthly on/off)',
        '/support - Draft and send a support request (confirms before sending)',
        '/update - Check for and apply updates (check/apply)',
        '/version - Show current version',
        '/chatid - Show your chat ID',
        '/help - This message',
      ].join('\n'))
      return
    }

    // Regular text message -> agent. Reply / quote / forward context rides
    // along as clearly-bounded untrusted text.
    await handleMessage(adapter, chatId, applyReplyContext(msg.replyContext, text))
  })

  return {
    async registerCommands(): Promise<void> {
      if (adapter.setCommands) {
        await adapter.setCommands([
          { command: 'newchat', description: 'Clear session, start fresh' },
          { command: 'memory', description: 'Show recent stored memories' },
          { command: 'voice', description: 'Toggle voice replies' },
          { command: 'shortcut', description: 'Use me from Siri and Apple Shortcuts' },
          { command: 'schedule', description: 'Manage scheduled tasks' },
          { command: 'dashboard', description: 'Dashboard (start/stop)' },
          { command: 'browser', description: 'Chrome CDP (start/stop/status)' },
          { command: 'steer', description: 'Inject mid-run steering message' },
          { command: 'skill', description: 'Manage skills (list/enable/disable/reload)' },
          { command: 'secret', description: 'Manage API keys in the encrypted vault' },
          { command: 'authorize', description: 'Manage multi-chat access (primary only)' },
          { command: 'workspace', description: 'Shared workspaces (primary only)' },
          { command: 'audit', description: 'Review how you have been using the assistant' },
          { command: 'support', description: 'Draft and send a support request' },
          { command: 'update', description: 'Check for and apply updates' },
          { command: 'version', description: 'Show current version' },
          { command: 'chatid', description: 'Show your chat ID' },
          { command: 'help', description: 'Show help' },
        ])
      }
    },
  }
}

/**
 * Send a message to a chat from outside the bot (the voice page handing an
 * answer over to the chat).
 *
 * This was a stub that logged a warning and sent nothing, so every voice
 * question that outran VOICE_HANDOFF_SECONDS was acknowledged aloud ("I'll
 * send the details to Telegram") and then never arrived. It throws when no
 * adapter is bound so the callers' .catch() logs the loss instead of the
 * message vanishing quietly.
 */
export async function sendPlatformMessage(chatId: string, text: string): Promise<void> {
  if (!(await deliverToChat(chatId, text))) throw new Error('no platform adapter bound')
}
