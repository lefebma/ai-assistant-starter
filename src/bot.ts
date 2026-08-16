/**
 * Bot core: platform-agnostic message handling.
 * Receives messages via PlatformAdapter, dispatches to the Claude agent,
 * handles commands, streaming, memory, and inline buttons.
 */

import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

import { PRIMARY_CHAT_ID, TYPING_REFRESH_MS, OPENAI_API_KEY, SUPPORT_EMAIL } from './config.js'
import { getSession, setSession, clearSession, getMemoriesForChat } from './db.js'
import { createTask, getAllTasks, deleteTask, pauseTask, resumeTask } from './db.js'
import { addAuthorizedChat, removeAuthorizedChat, getAuthorizedChats, isAuthorizedChat } from './db.js'
import { decideAccess } from './access.js'
import { runAgent, steerAgent, isChatBusy, markLane, clearLane } from './agent.js'
import { saveConversationTurn } from './memory.js'
import { createDefaultEngine } from './memory/engine.js'
import { synthesizeSpeech, transcribeAudio, voiceCapabilities } from './voice.js'
import { buildPhotoMessage, buildDocumentMessage, buildVideoMessage, UPLOADS_DIR } from './media.js'
import { computeNextRun } from './scheduler.js'
import { logger } from './logger.js'
import { commandWord } from './infra/command-text.js'
import { CronExpressionParser } from 'cron-parser'
import { launchChrome, stopChrome, getBrowserStatus, isCdpAvailable } from './browser.js'
import { getSkills, setSkillEnabled, reloadSkills, buildSkillIndex } from './skills/index.js'
import { checkForUpdate, applyUpdate, getCurrentVersion, getChangelog } from './updater.js'
import {
  collectDiagnostics,
  buildSupportDraft,
  formatDraftPreview,
  sendSupportEmail,
  saveSupportRequest,
} from './support/index.js'
import type { SupportDraft } from './support/index.js'
import type { PlatformAdapter, IncomingMessage } from './platform/types.js'

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

// --- Core message handling ---

async function handleMessage(
  adapter: PlatformAdapter,
  chatId: string,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  // Always-on skill catalog so the assistant knows its full toolbox and can route
  // to a skill even when the message lacks a literal trigger word. Kept as its
  // own block (not via ContextEngine) so it bypasses the "prior conversation
  // history" framing and the engine's token-budget truncation.
  const skillIndex = buildSkillIndex()

  // Build memory context via ContextEngine
  const memoryContext = await contextEngine.buildContext(chatId, rawText)
  const fullMessage = [skillIndex, memoryContext, rawText]
    .filter(Boolean)
    .join('\n\n')

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
          const indicator = `\n\n>> ${toolName}...`
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

    if (!response) {
      if (previewMessageId != null) {
        await adapter.editMessage(chatId, previewMessageId, '(no response)')
      } else {
        await adapter.sendMessage(chatId, '(no response)')
      }
      return
    }

    // Save to memory
    await saveConversationTurn(chatId, rawText, response)

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

    // Extract inline buttons
    const { cleanText, labels } = extractButtons(response)
    const buttonOpts = labels.length > 0 && adapter.supportsButtons ? { buttons: labels } : {}

    // Format and deliver
    const formatted = adapter.formatText(cleanText)
    const chunks = adapter.splitMessage(formatted)
    const lastIdx = chunks.length - 1

    if (previewMessageId != null) {
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
  } finally {
    if (pendingEditTimer) clearTimeout(pendingEditTimer)
    clearInterval(typingInterval)
    clearLane(chatId)
  }
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
      await adapter.sendMessage(chatId, `Update check failed: ${status.error}`)
      return
    }
    if (status.updateAvailable && status.latestVersion) {
      const changelog = await getChangelog()
      let msg = `Update available: v${status.currentVersion} -> v${status.latestVersion}`
      if (changelog) {
        msg += `\n\n${changelog.slice(0, 800)}`
      }
      msg += '\n\nRun /update apply to install.'
      await adapter.sendMessage(chatId, msg)
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
        'Your .env, CLAUDE.md, skills, and data are preserved.\n' +
        'The service will need a restart after.\n\n' +
        'Run /update apply again to confirm.'
      )
      // Auto-expire confirmation after 2 minutes
      setTimeout(() => pendingUpdateConfirm.delete(chatId), 120_000)
      return
    }

    pendingUpdateConfirm.delete(chatId)
    await adapter.sendMessage(chatId, 'Downloading and applying update... this may take a minute.')

    const result = await applyUpdate()
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

    // Handle media
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
      await handleMessage(adapter, chatId, message)
      return
    }

    if (type === 'document' && msg.filePath) {
      const message = buildDocumentMessage(msg.filePath, msg.fileName ?? 'document', msg.caption)
      await handleMessage(adapter, chatId, message)
      return
    }

    if (type === 'video' && msg.filePath) {
      const message = buildVideoMessage(msg.filePath, msg.caption)
      await handleMessage(adapter, chatId, message)
      return
    }

    // Text messages: route commands. `cmd` is the leading word, lowercased;
    // handlers still receive `trimmed` so argument case survives.
    const trimmed = text.trim()
    const cmd = commandWord(trimmed)

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

    // Command routing
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
    if (cmd === '/authorize') {
      await handleAuthorizeCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/support') {
      await handleSupportCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/version') {
      await adapter.sendMessage(chatId, `AI Assistant v${getCurrentVersion()}`)
      return
    }
    if (cmd === '/update') {
      await handleUpdateCommand(adapter, chatId, trimmed)
      return
    }
    if (cmd === '/help') {
      await adapter.sendMessage(chatId, [
        'Commands:',
        '/newchat - Clear session, start fresh',
        '/memory - Show stored memories',
        '/voice - Toggle voice replies',
        '/schedule - Manage scheduled tasks',
        '/dashboard - Dashboard (start/stop)',
        '/browser - Chrome CDP (start/stop/status)',
        '/steer - Inject mid-run steering message',
        '/skill - Manage skills (list/enable/disable/reload)',
        '/authorize - Manage multi-chat access (add/remove/list)',
        '/support - Draft and send a support request (confirms before sending)',
        '/update - Check for and apply updates (check/apply)',
        '/version - Show current version',
        '/chatid - Show your chat ID',
        '/help - This message',
      ].join('\n'))
      return
    }

    // Regular text message -> agent
    await handleMessage(adapter, chatId, text)
  })

  return {
    async registerCommands(): Promise<void> {
      if (adapter.setCommands) {
        await adapter.setCommands([
          { command: 'newchat', description: 'Clear session, start fresh' },
          { command: 'memory', description: 'Show recent stored memories' },
          { command: 'voice', description: 'Toggle voice replies' },
          { command: 'schedule', description: 'Manage scheduled tasks' },
          { command: 'dashboard', description: 'Dashboard (start/stop)' },
          { command: 'browser', description: 'Chrome CDP (start/stop/status)' },
          { command: 'steer', description: 'Inject mid-run steering message' },
          { command: 'skill', description: 'Manage skills (list/enable/disable/reload)' },
          { command: 'authorize', description: 'Manage multi-chat access (primary only)' },
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
 * Send a message via the adapter. Used by scheduler and other callers.
 * This is a convenience wrapper -- the actual adapter instance is created in index.ts.
 * For backward compatibility, this function is a no-op if no adapter is available.
 */
export async function sendPlatformMessage(chatId: string, text: string): Promise<void> {
  // This function exists for backward compatibility with code that imports sendTelegramMessage.
  // In the new architecture, the scheduler gets its sender function from index.ts directly.
  logger.warn('sendPlatformMessage called without adapter context. Use adapter.sendMessage instead.')
}
