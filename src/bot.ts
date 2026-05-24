import { Bot, InputFile, InlineKeyboard } from 'grammy'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

import {
  TELEGRAM_BOT_TOKEN,
  PRIMARY_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js'
import { getSession, setSession, clearSession, getMemoriesForChat } from './db.js'
import { createTask, getAllTasks, deleteTask, pauseTask, resumeTask } from './db.js'
import { addAuthorizedChat, removeAuthorizedChat, getAuthorizedChats, isAuthorizedChat } from './db.js'
import { hasProcessedUpdate, markUpdateProcessed } from './db.js'
import { runAgent, steerAgent, isChatBusy, markLane, clearLane } from './agent.js'
import { saveConversationTurn } from './memory.js'
import { createDefaultEngine } from './memory/engine.js'
import { synthesizeSpeech, transcribeAudio, voiceCapabilities } from './voice.js'
import { downloadTelegramFile, buildPhotoMessage, buildDocumentMessage, buildVideoMessage, UPLOADS_DIR } from './media.js'
import { computeNextRun } from './scheduler.js'
import { logger } from './logger.js'
import { CronExpressionParser } from 'cron-parser'
import { launchChrome, stopChrome, getBrowserStatus, isCdpAvailable } from './browser.js'
import { getSkills, setSkillEnabled, reloadSkills } from './skills/index.js'

// Non-abort text patterns (OpenClaw v2026.5.18 -- /btw non-abort behavior).
// These read-only commands should never kill an active agent run. When the chat
// is busy, they're handled locally without dispatching to the agent.
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

function isPrimaryChat(chatId: number): boolean {
  return !!PRIMARY_CHAT_ID && String(chatId) === PRIMARY_CHAT_ID
}

function isAuthorised(chatId: number): boolean {
  if (!PRIMARY_CHAT_ID) return true // First-run mode
  if (String(chatId) === PRIMARY_CHAT_ID) return true
  return isAuthorizedChat(String(chatId))
}

// --- Telegram HTML formatting ---

function formatForTelegram(text: string): string {
  // Extract and protect code blocks
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    const block = lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`
    codeBlocks.push(block)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  // Protect inline code
  const inlineCode: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINE${inlineCode.length - 1}\x00`
  })

  // Escape HTML in remaining text
  result = result.replace(/[&<>]/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    return '&gt;'
  })

  // Convert markdown to HTML
  // Headings -> bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')
  // Italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // Checkboxes
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')
  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Restore code blocks and inline code
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, i) => codeBlocks[Number(i)])
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, i) => inlineCode[Number(i)])

  return result.trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt === -1 || splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt === -1 || splitAt < limit * 0.5) {
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

// --- Inline buttons ---
// Agent asks for confirmation by emitting `[[buttons: Send | Discard]]` anywhere in its final reply.
// We strip the marker from what the user sees, attach the labels as inline buttons, and feed the
// clicked label back to the agent as the next user turn.
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

function buildInlineKeyboard(labels: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  // Pack short labels side by side, put longer ones on their own row.
  let rowLen = 0
  for (const label of labels) {
    const data = `btn:${label}`.slice(0, 60)
    if (rowLen + label.length > 30) {
      kb.row()
      rowLen = 0
    }
    kb.text(label, data)
    rowLen += label.length
  }
  return kb
}

// --- Message handling ---

async function handleMessage(
  bot: Bot,
  chatId: number,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatIdStr = String(chatId)

  // Build memory context via ContextEngine
  const memoryContext = await contextEngine.buildContext(chatIdStr, rawText)
  const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText

  // Get existing session
  const sessionId = getSession(chatIdStr) ?? undefined

  logger.info({ chatId, messageLength: rawText.length }, 'Processing message')

  // Start typing indicator (refreshes every 4s)
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(chatId, 'typing').catch(() => {})
  }, TYPING_REFRESH_MS)
  await bot.api.sendChatAction(chatId, 'typing').catch(() => {})

  // Streaming preview: don't stream when the reply will be voice (TTS happens after text settles).
  const willVoice = (forceVoiceReply || voiceModeChats.has(chatIdStr)) && voiceCapabilities().tts
  const streamingEnabled = !willVoice

  // Placeholder message we'll edit as the agent streams. We create it lazily on the first delta
  // so fast responses still feel instant and silent tools don't leave orphan placeholders.
  let previewMessageId: number | null = null
  const STREAM_PREVIEW_LIMIT = 3800 // leave headroom under 4096 for formatting expansion
  const EDIT_THROTTLE_MS = 1500
  let lastEditMs = 0
  let lastRenderedPreview = ''
  let pendingEditTimer: NodeJS.Timeout | null = null
  let pendingPreviewText = ''

  async function renderPreview(text: string): Promise<void> {
    // Cap at limit and tag as truncated so user knows more is coming
    const truncated = text.length > STREAM_PREVIEW_LIMIT
    const body = truncated ? text.slice(0, STREAM_PREVIEW_LIMIT) + '\n\n… (still writing)' : text
    if (body === lastRenderedPreview) return
    lastRenderedPreview = body
    try {
      if (previewMessageId == null) {
        const sent = await bot.api.sendMessage(chatId, body)
        previewMessageId = sent.message_id
      } else {
        await bot.api.editMessageText(chatId, previewMessageId, body)
      }
    } catch (err) {
      // Telegram occasionally rejects "message is not modified" or rate-limits; swallow.
      logger.debug({ err }, 'Preview edit skipped')
    }
  }

  function scheduleStreamEdit(accumulated: string): void {
    pendingPreviewText = accumulated
    const now = Date.now()
    const wait = Math.max(0, EDIT_THROTTLE_MS - (now - lastEditMs))
    if (pendingEditTimer) return // already queued
    pendingEditTimer = setTimeout(() => {
      pendingEditTimer = null
      lastEditMs = Date.now()
      void renderPreview(pendingPreviewText)
    }, wait)
  }

  // Mark chat lane active so cron tasks defer (OpenClaw v2026.5.19)
  markLane(chatIdStr, 'chat')

  try {
    // Tool progress callback: show tool names in streaming preview (OpenClaw v2026.5.19)
    const onToolProg = streamingEnabled
      ? (toolName: string, _status: string) => {
          const indicator = `\n\n>> ${toolName}...`
          scheduleStreamEdit((pendingPreviewText || '') + indicator)
        }
      : undefined

    const onPartial = streamingEnabled ? scheduleStreamEdit : undefined
    const { text: response, newSessionId } = await runAgent(fullMessage, sessionId, undefined, onPartial, onToolProg)

    // Flush any pending throttled edit so the placeholder isn't stale right before the final replace.
    if (pendingEditTimer) {
      clearTimeout(pendingEditTimer)
      pendingEditTimer = null
    }

    if (newSessionId) {
      setSession(chatIdStr, newSessionId)
    }

    if (!response) {
      if (previewMessageId != null) {
        await bot.api.editMessageText(chatId, previewMessageId, '(no response)').catch(() => {})
      } else {
        await bot.api.sendMessage(chatId, '(no response)')
      }
      return
    }

    // Save to memory
    await saveConversationTurn(chatIdStr, rawText, response)

    // Voice reply?
    if (willVoice) {
      try {
        const audioBuffer = await synthesizeSpeech(response)
        const audioPath = resolve(UPLOADS_DIR, `tts_${Date.now()}.mp3`)
        writeFileSync(audioPath, audioBuffer)
        await bot.api.sendVoice(chatId, new InputFile(audioPath))
      } catch (err) {
        logger.error({ err }, 'TTS failed, sending text')
      }
    }

    // Inline buttons: strip the marker, build keyboard. Keyboard attaches to the last message/edit.
    const { cleanText, labels } = extractButtons(response)
    const keyboard = labels.length > 0 ? buildInlineKeyboard(labels) : undefined

    // Final delivery: replace the streamed plaintext preview with the formatted HTML version.
    const formatted = formatForTelegram(cleanText)
    const chunks = splitMessage(formatted)
    const lastIdx = chunks.length - 1

    const withKeyboard = (idx: number): { reply_markup?: InlineKeyboard } =>
      idx === lastIdx && keyboard ? { reply_markup: keyboard } : {}

    if (previewMessageId != null) {
      // Replace placeholder with first chunk (with formatting); send the rest as new messages.
      const [first, ...rest] = chunks
      const firstExtras = withKeyboard(0)
      try {
        await bot.api.editMessageText(chatId, previewMessageId, first, { parse_mode: 'HTML', ...firstExtras })
      } catch {
        // HTML parse can fail on complex output; fall back to plain text edit.
        await bot.api.editMessageText(chatId, previewMessageId, first, firstExtras).catch(() => {})
      }
      for (let i = 0; i < rest.length; i++) {
        const chunkIdx = i + 1
        const extras = withKeyboard(chunkIdx)
        try {
          await bot.api.sendMessage(chatId, rest[i], { parse_mode: 'HTML', ...extras })
        } catch {
          await bot.api.sendMessage(chatId, rest[i], extras)
        }
      }
    } else {
      // No streaming happened (voice mode or no deltas arrived): send fresh.
      for (let i = 0; i < chunks.length; i++) {
        const extras = withKeyboard(i)
        try {
          await bot.api.sendMessage(chatId, chunks[i], { parse_mode: 'HTML', ...extras })
        } catch {
          await bot.api.sendMessage(chatId, chunks[i], extras)
        }
      }
    }
  } finally {
    if (pendingEditTimer) clearTimeout(pendingEditTimer)
    clearInterval(typingInterval)
    clearLane(chatIdStr)
  }
}

// --- Schedule commands ---

async function handleScheduleCommand(bot: Bot, chatId: number, text: string): Promise<void> {
  const chatIdStr = String(chatId)
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const tasks = getAllTasks()
    if (tasks.length === 0) {
      await bot.api.sendMessage(chatId, 'No scheduled tasks.')
      return
    }
    const lines = tasks.map((t) => {
      const label = t.name ?? t.prompt.slice(0, 60)
      const mode = t.delivery_mode === 'silent' ? ' [silent]' : ''
      return `[${t.status}${mode}] ${t.id}: ${label}\nSchedule: ${t.schedule} | Next: ${new Date(t.next_run * 1000).toLocaleString()}`
    })
    await bot.api.sendMessage(chatId, lines.join('\n\n'))
    return
  }

  if (subcmd === 'create') {
    const match = text.match(/create\s+"([^"]+)"\s+"([^"]+)"/)
    if (!match) {
      await bot.api.sendMessage(chatId, 'Usage: /schedule create "prompt" "cron" [--name "name"] [--silent]')
      return
    }
    const [, prompt, cron] = match
    try {
      CronExpressionParser.parse(cron)
    } catch {
      await bot.api.sendMessage(chatId, `Invalid cron expression: ${cron}`)
      return
    }
    const nameMatch = text.match(/--name\s+"([^"]+)"/)
    const name = nameMatch?.[1] ?? null
    const isSilent = text.includes('--silent')
    const deliveryMode = isSilent ? 'silent' as const : 'announce' as const

    const id = randomUUID().slice(0, 8)
    const nextRun = computeNextRun(cron, 'America/Toronto')
    createTask(id, chatIdStr, prompt, cron, nextRun, name ?? undefined, deliveryMode, 'America/Toronto')
    await bot.api.sendMessage(
      chatId,
      `Task created: ${id}${name ? ` (${name})` : ''}\nMode: ${deliveryMode}\nSchedule: ${cron}\nNext run: ${new Date(nextRun * 1000).toLocaleString()}`
    )
    return
  }

  if (subcmd === 'delete') {
    const id = parts[2]
    if (!id) { await bot.api.sendMessage(chatId, 'Usage: /schedule delete <id>'); return }
    await bot.api.sendMessage(chatId, deleteTask(id) ? `Task ${id} deleted.` : `Task ${id} not found.`)
    return
  }

  if (subcmd === 'pause') {
    const id = parts[2]
    if (!id) { await bot.api.sendMessage(chatId, 'Usage: /schedule pause <id>'); return }
    await bot.api.sendMessage(chatId, pauseTask(id) ? `Task ${id} paused.` : `Task ${id} not found.`)
    return
  }

  if (subcmd === 'resume') {
    const id = parts[2]
    if (!id) { await bot.api.sendMessage(chatId, 'Usage: /schedule resume <id>'); return }
    const tasks = getAllTasks()
    const task = tasks.find((t) => t.id === id)
    if (!task) { await bot.api.sendMessage(chatId, `Task ${id} not found.`); return }
    const nextRun = computeNextRun(task.schedule)
    if (resumeTask(id, nextRun)) {
      await bot.api.sendMessage(chatId, `Task ${id} resumed. Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    } else {
      await bot.api.sendMessage(chatId, `Failed to resume task ${id}.`)
    }
    return
  }

  await bot.api.sendMessage(chatId, 'Unknown schedule command. Use: list, create, delete, pause, resume')
}

// --- Browser commands ---

async function handleBrowserCommand(bot: Bot, chatId: number, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'status') {
    const status = await getBrowserStatus()
    await bot.api.sendMessage(chatId, status)
    return
  }

  if (subcmd === 'start') {
    const already = await isCdpAvailable()
    if (already) {
      await bot.api.sendMessage(chatId, 'Chrome CDP is already running on port 9222.')
      return
    }
    // --default flag uses the user's real Chrome profile (all cookies/logins)
    const useDefault = text.includes('--default')
    const ok = launchChrome({ useDefaultProfile: useDefault })
    if (ok) {
      const mode = useDefault ? 'default profile (your logins)' : 'isolated profile'
      await bot.api.sendMessage(chatId, `Chrome launched with CDP on port 9222 (${mode}).\nPlaywright MCP can now connect via --cdp-endpoint.`)
    } else {
      await bot.api.sendMessage(chatId, 'Failed to launch Chrome. Check logs.')
    }
    return
  }

  if (subcmd === 'stop') {
    const stopped = stopChrome()
    await bot.api.sendMessage(chatId, stopped ? 'Chrome CDP stopped.' : 'No Chrome CDP instance found to stop.')
    return
  }

  await bot.api.sendMessage(chatId, 'Usage: /browser [start|stop|status]\n  --default: use your real Chrome profile')
}

// --- Skill commands ---

async function handleSkillCommand(bot: Bot, chatId: number, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const skills = getSkills()
    if (skills.length === 0) {
      await bot.api.sendMessage(chatId, 'No skills installed.\nDrop folders into skills/ or ~/.ai-assistant/skills/')
      return
    }
    const lines = skills.map(s => {
      const status = s.manifest.enabled ? '✓' : '✗'
      const triggers = s.manifest.triggers.slice(0, 5).join(', ')
      return `${status} ${s.manifest.name} (${s.manifest.id})\n  Triggers: ${triggers}\n  Priority: ${s.manifest.priority ?? 50}`
    })
    await bot.api.sendMessage(chatId, lines.join('\n\n'))
    return
  }

  if (subcmd === 'enable' || subcmd === 'disable') {
    const id = parts[2]
    if (!id) {
      await bot.api.sendMessage(chatId, `Usage: /skill ${subcmd} <id>`)
      return
    }
    const ok = setSkillEnabled(id, subcmd === 'enable')
    await bot.api.sendMessage(chatId, ok ? `Skill ${id} ${subcmd}d.` : `Skill ${id} not found.`)
    return
  }

  if (subcmd === 'reload') {
    const skills = reloadSkills()
    await bot.api.sendMessage(chatId, `Reloaded ${skills.length} skill(s).`)
    return
  }

  await bot.api.sendMessage(chatId, 'Usage: /skill [list|enable|disable|reload]')
}

// --- Authorize commands ---

async function handleAuthorizeCommand(bot: Bot, chatId: number, text: string): Promise<void> {
  if (!isPrimaryChat(chatId)) {
    await bot.api.sendMessage(chatId, 'Only the primary chat can manage authorized chats.')
    return
  }

  const parts = text.trim().split(/\s+/)
  const subcmd = parts[1]?.toLowerCase()

  if (!subcmd || subcmd === 'list') {
    const chats = getAuthorizedChats()
    if (chats.length === 0) {
      await bot.api.sendMessage(chatId, 'No additional chats authorized. Only the primary chat is active.')
      return
    }
    const lines = chats.map((c) => {
      const label = c.label ? ` (${c.label})` : ''
      return `${c.chat_id}${label} - added ${new Date(c.created_at * 1000).toLocaleDateString()}`
    })
    await bot.api.sendMessage(chatId, `Authorized chats:\n${lines.join('\n')}`)
    return
  }

  if (subcmd === 'add') {
    const targetId = parts[2]
    if (!targetId) {
      await bot.api.sendMessage(chatId, 'Usage: /authorize add <chat_id> [label]')
      return
    }
    const label = parts.slice(3).join(' ') || null
    addAuthorizedChat(targetId, label, String(chatId))
    unauthorizedReplied.delete(targetId)
    await bot.api.sendMessage(chatId, `Chat ${targetId} authorized.${label ? ` Label: ${label}` : ''}`)
    return
  }

  if (subcmd === 'remove') {
    const targetId = parts[2]
    if (!targetId) {
      await bot.api.sendMessage(chatId, 'Usage: /authorize remove <chat_id>')
      return
    }
    const removed = removeAuthorizedChat(targetId)
    await bot.api.sendMessage(chatId, removed ? `Chat ${targetId} deauthorized.` : `Chat ${targetId} was not authorized.`)
    return
  }

  await bot.api.sendMessage(chatId, 'Usage: /authorize [add|remove|list]')
}

// --- Bot creation ---

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.fatal('TELEGRAM_BOT_TOKEN not set. Run "npm run setup" or add it to .env')
    process.exit(1)
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  // Populate the native Telegram command menu (the one that pops up when the user types "/").
  // Fire-and-forget: a failure here should never block the bot from starting.
  bot.api
    .setMyCommands([
      { command: 'newchat', description: 'Clear session, start fresh' },
      { command: 'memory', description: 'Show recent stored memories' },
      { command: 'voice', description: 'Toggle voice replies' },
      { command: 'schedule', description: 'Manage scheduled tasks' },
      { command: 'dashboard', description: 'Kai Dashboard (start/stop)' },
      { command: 'browser', description: 'Chrome CDP (start/stop/status)' },
      { command: 'steer', description: 'Inject mid-run steering message' },
      { command: 'skill', description: 'Manage skills (list/enable/disable/reload)' },
      { command: 'authorize', description: 'Manage multi-chat access (primary only)' },
      { command: 'chatid', description: 'Show your chat ID' },
      { command: 'help', description: 'Show help' },
    ])
    .then(() => logger.info('Telegram command menu registered'))
    .catch((err) => logger.warn({ err }, 'Failed to register Telegram command menu'))

  // --- Replay protection ---
  // Telegram redelivers updates that weren't acked (process crash, restart mid-handler).
  // Two-layer guard:
  //   1. Drop updates older than MAX_UPDATE_AGE_SEC (clears stuck queue on startup)
  //   2. Persist processed update_ids in SQLite so we never run the same one twice.
  const MAX_UPDATE_AGE_SEC = 120
  const startupTime = Math.floor(Date.now() / 1000)

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id
    const msgDate = ctx.message?.date ?? ctx.editedMessage?.date ?? 0

    if (msgDate && startupTime - msgDate > MAX_UPDATE_AGE_SEC) {
      logger.warn({ updateId, ageSec: startupTime - msgDate }, 'Dropping stale update')
      markUpdateProcessed(updateId)
      return
    }

    if (hasProcessedUpdate(updateId)) {
      logger.warn({ updateId }, 'Dropping already-processed update (replay)')
      return
    }

    // Mark BEFORE running the handler so a mid-handler crash doesn't cause replay.
    markUpdateProcessed(updateId)
    await next()
  })

  bot.command('start', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await ctx.reply('AI Assistant is running. Send me anything and I\'ll process it with Claude Code.')
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID is: ${ctx.chat.id}`)
  })

  bot.command('newchat', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    clearSession(String(ctx.chat.id))
    reloadSkills()  // Clear stale skill cache (OpenClaw v2026.5.7)
    contextEngine.invalidateCaches()  // Invalidate context caches
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('forget', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    clearSession(String(ctx.chat.id))
    reloadSkills()
    contextEngine.invalidateCaches()
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    if (voiceModeChats.has(chatIdStr)) {
      voiceModeChats.delete(chatIdStr)
      await ctx.reply('Voice replies disabled.')
    } else {
      if (!voiceCapabilities().tts) {
        await ctx.reply('TTS not configured. Set OPENAI_API_KEY in .env')
        return
      }
      voiceModeChats.add(chatIdStr)
      await ctx.reply('Voice replies enabled. Send /voice again to disable.')
    }
  })

  bot.command('memory', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const memories = getMemoriesForChat(String(ctx.chat.id), 10)
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.')
    } else {
      const lines = memories.map(
        (m) => `[${m.sector}] (${m.salience.toFixed(2)}) ${m.content.slice(0, 100)}`
      )
      await ctx.reply(`Recent memories:\n\n${lines.join('\n')}`)
    }
  })

  bot.command('schedule', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await handleScheduleCommand(bot, ctx.chat.id, ctx.message?.text ?? '')
  })

  bot.command('dashboard', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const dashSubcmd = (ctx.message?.text ?? '').trim().split(/\s+/)[1]?.toLowerCase()
    const plist = resolve(homedir(), 'Library/LaunchAgents/com.ai-assistant.dashboard.plist')

    if (dashSubcmd === 'start') {
      try {
        execFileSync('launchctl', ['load', plist], { stdio: 'ignore' })
        await ctx.reply('Dashboard data API started on port 3002.\nFor UI: cd ~/clawd/dashboard && npm run dev')
      } catch {
        await ctx.reply('Failed to start dashboard. Check the plist exists.')
      }
    } else if (dashSubcmd === 'stop') {
      try {
        execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' })
        await ctx.reply('Dashboard service stopped.')
      } catch {
        await ctx.reply('Failed to stop dashboard.')
      }
    } else {
      await ctx.reply('Dashboard data API: http://localhost:3002\nUI: cd ~/clawd/dashboard && npm run dev\nCommands: /dashboard start, /dashboard stop')
    }
  })

  bot.command('browser', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await handleBrowserCommand(bot, ctx.chat.id, ctx.message?.text ?? '')
  })

  // /steer - inject a mid-run steering message (OpenClaw v2026.5.3)
  bot.command('steer', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const steerText = (ctx.message?.text ?? '').replace(/^\/steer\s*/i, '').trim()
    if (!steerText) {
      await ctx.reply('Usage: /steer <message>\nInjects a steering message into the currently running agent. The message will be processed after the current tool call completes.')
      return
    }
    steerAgent(steerText)
    await ctx.reply(`Steer queued: "${steerText.slice(0, 80)}${steerText.length > 80 ? '...' : ''}"`)
  })

  bot.command('skill', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await handleSkillCommand(bot, ctx.chat.id, ctx.message?.text ?? '')
  })

  bot.command('authorize', async (ctx) => {
    await handleAuthorizeCommand(bot, ctx.chat.id, ctx.message?.text ?? '')
  })

  bot.command('help', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await ctx.reply(
      [
        'Commands:',
        '/newchat - Clear session, start fresh',
        '/memory - Show stored memories',
        '/voice - Toggle voice replies',
        '/schedule - Manage scheduled tasks',
        '/dashboard - Kai Dashboard (start/stop)',
        '/browser - Chrome CDP (start/stop/status)',
        '/steer - Inject mid-run steering message',
        '/skill - Manage skills (list/enable/disable/reload)',
        '/authorize - Manage multi-chat access (add/remove/list)',
        '/chatid - Show your chat ID',
        '/help - This message',
      ].join('\n')
    )
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) {
      logger.warn({ chatId: ctx.chat.id }, 'Unauthorized message')
      const chatIdStr = String(ctx.chat.id)
      if (!unauthorizedReplied.has(chatIdStr)) {
        unauthorizedReplied.add(chatIdStr)
        await ctx.reply(`Not authorized. Chat ID: ${ctx.chat.id}\nAsk the owner to run: /authorize add ${ctx.chat.id} from the primary chat.`)
      }
      return
    }

    // /btw non-abort (OpenClaw v2026.5.18): if the agent is busy and this is
    // a read-only command, don't dispatch it -- just acknowledge.
    const msgText = ctx.message.text
    if (isChatBusy(String(ctx.chat.id)) && isNonAbortMessage(msgText)) {
      logger.info({ chatId: ctx.chat.id, text: msgText.slice(0, 40) }, 'Non-abort command during active run')
      await ctx.reply('Agent is busy. That command will work once the current task finishes.')
      return
    }

    await handleMessage(bot, ctx.chat.id, msgText)
  })

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (!voiceCapabilities().stt) {
      await ctx.reply('Voice transcription is not enabled. Add OPENAI_API_KEY to .env.')
      return
    }
    try {
      const localPath = await downloadTelegramFile(TELEGRAM_BOT_TOKEN, ctx.message.voice.file_id, 'voice.ogg')
      const transcript = await transcribeAudio(localPath)
      if (!transcript.trim()) {
        await ctx.reply('Could not transcribe audio.')
        return
      }
      await handleMessage(bot, ctx.chat.id, `[Voice message transcription]: ${transcript}`, true)
    } catch (err) {
      logger.error({ err }, 'Voice transcription failed')
      await ctx.reply('Failed to transcribe voice message.')
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    try {
      const localPath = await downloadTelegramFile(TELEGRAM_BOT_TOKEN, largest.file_id)
      const message = buildPhotoMessage(localPath, ctx.message.caption ?? undefined)
      await handleMessage(bot, ctx.chat.id, message)
    } catch (err) {
      logger.error({ err }, 'Failed to download photo')
      await ctx.reply('Failed to download photo.')
    }
  })

  // Documents
  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const doc = ctx.message.document
    try {
      const localPath = await downloadTelegramFile(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name ?? undefined)
      const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption ?? undefined)
      await handleMessage(bot, ctx.chat.id, message)
    } catch (err) {
      logger.error({ err }, 'Failed to download document')
      await ctx.reply('Failed to download document.')
    }
  })

  // Video
  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const video = ctx.message.video
    try {
      const localPath = await downloadTelegramFile(TELEGRAM_BOT_TOKEN, video.file_id, video.file_name ?? undefined)
      const message = buildVideoMessage(localPath, ctx.message.caption ?? undefined)
      await handleMessage(bot, ctx.chat.id, message)
    } catch (err) {
      logger.error({ err }, 'Failed to download video')
      await ctx.reply('Failed to download video.')
    }
  })

  // Inline button clicks feed the selected label back into the agent as the next user turn.
  bot.on('callback_query:data', async (ctx) => {
    if (!isAuthorised(ctx.chat?.id ?? 0)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' })
      return
    }
    const data = ctx.callbackQuery.data
    if (!data.startsWith('btn:')) {
      await ctx.answerCallbackQuery()
      return
    }
    const label = data.slice(4)
    await ctx.answerCallbackQuery({ text: `Selected: ${label}` })
    // Strip the keyboard from the original message so it can't be clicked again.
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } catch {
      // Message may have been edited away; ignore.
    }
    if (ctx.chat) {
      await handleMessage(bot, ctx.chat.id, `[button_click]: ${label}`)
    }
  })

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error')
  })

  return bot
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return
  const bot = new Bot(TELEGRAM_BOT_TOKEN)
  const formatted = formatForTelegram(text)
  for (const chunk of splitMessage(formatted)) {
    try {
      await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML' })
    } catch {
      await bot.api.sendMessage(Number(chatId), chunk)
    }
  }
}
