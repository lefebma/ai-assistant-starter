/**
 * Telegram adapter using grammY.
 * Wraps all Telegram-specific I/O: polling, sending, editing, formatting.
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy'
import { downloadTelegramFile, UPLOADS_DIR } from '../media.js'
import { hasProcessedUpdate, markUpdateProcessed } from '../db.js'
import { handlePollingTermination } from '../infra/telegram-conflict.js'
import { logger } from '../logger.js'
import type { PlatformAdapter, IncomingMessage, SendOptions } from './types.js'

export class TelegramAdapter implements PlatformAdapter {
  readonly name = 'telegram' as const
  readonly maxMessageLength = 4096
  readonly supportsEdit = true
  readonly supportsButtons = true

  private bot: Bot
  private token: string
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private activityHandler: (() => void) | null = null

  constructor(token: string) {
    this.token = token
    this.bot = new Bot(token)
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onActivity(handler: () => void): void {
    this.activityHandler = handler
  }

  async start(): Promise<void> {
    const MAX_UPDATE_AGE_SEC = 120
    const startupTime = Math.floor(Date.now() / 1000)

    // Replay protection middleware
    this.bot.use(async (ctx, next) => {
      // Activity heartbeat
      this.activityHandler?.()

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
      markUpdateProcessed(updateId)
      await next()
    })

    // Route all message types to the unified handler
    this.bot.on('message:text', async (ctx) => {
      await this.messageHandler?.({
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? ctx.chat.id),
        text: ctx.message.text,
        type: 'text',
        updateId: ctx.update.update_id,
      })
    })

    this.bot.on('message:voice', async (ctx) => {
      try {
        const localPath = await downloadTelegramFile(this.token, ctx.message.voice.file_id, 'voice.ogg')
        await this.messageHandler?.({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ctx.chat.id),
          text: '',
          type: 'voice',
          filePath: localPath,
          updateId: ctx.update.update_id,
        })
      } catch (err) {
        logger.error({ err }, 'Failed to download voice message')
      }
    })

    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      try {
        const localPath = await downloadTelegramFile(this.token, largest.file_id)
        await this.messageHandler?.({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ctx.chat.id),
          text: ctx.message.caption ?? '',
          type: 'photo',
          filePath: localPath,
          caption: ctx.message.caption ?? undefined,
          updateId: ctx.update.update_id,
        })
      } catch (err) {
        logger.error({ err }, 'Failed to download photo')
      }
    })

    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document
      try {
        const localPath = await downloadTelegramFile(this.token, doc.file_id, doc.file_name ?? undefined)
        await this.messageHandler?.({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ctx.chat.id),
          text: ctx.message.caption ?? '',
          type: 'document',
          filePath: localPath,
          fileName: doc.file_name ?? 'document',
          caption: ctx.message.caption ?? undefined,
          updateId: ctx.update.update_id,
        })
      } catch (err) {
        logger.error({ err }, 'Failed to download document')
      }
    })

    this.bot.on('message:video', async (ctx) => {
      const video = ctx.message.video
      try {
        const localPath = await downloadTelegramFile(this.token, video.file_id, video.file_name ?? undefined)
        await this.messageHandler?.({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ctx.chat.id),
          text: ctx.message.caption ?? '',
          type: 'video',
          filePath: localPath,
          caption: ctx.message.caption ?? undefined,
          updateId: ctx.update.update_id,
        })
      } catch (err) {
        logger.error({ err }, 'Failed to download video')
      }
    })

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      await this.messageHandler?.({
        chatId: String(ctx.chat?.id ?? ''),
        userId: String(ctx.from?.id ?? ''),
        text: data,
        type: 'callback',
        callbackData: data,
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        updateId: ctx.update.update_id,
      })
    })

    this.bot.catch((err) => {
      logger.error({ err: err.error }, 'Bot error')
    })

    // Start polling
    this.bot.start().catch((err) => {
      handlePollingTermination(err)
    })
    logger.info('Telegram adapter started (long-polling)')
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string> {
    const extras: Record<string, unknown> = {}
    if (options?.parseMode === 'html') {
      extras.parse_mode = 'HTML'
    }
    if (options?.buttons?.length) {
      extras.reply_markup = this.buildKeyboard(options.buttons)
    }
    try {
      const sent = await this.bot.api.sendMessage(Number(chatId), text, extras)
      return String(sent.message_id)
    } catch {
      // Fallback without parse mode if HTML fails
      const fallbackExtras: Record<string, unknown> = {}
      if (options?.buttons?.length) {
        fallbackExtras.reply_markup = this.buildKeyboard(options.buttons)
      }
      const sent = await this.bot.api.sendMessage(Number(chatId), text, fallbackExtras)
      return String(sent.message_id)
    }
  }

  async editMessage(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void> {
    const extras: Record<string, unknown> = {}
    if (options?.parseMode === 'html') {
      extras.parse_mode = 'HTML'
    }
    if (options?.buttons?.length) {
      extras.reply_markup = this.buildKeyboard(options.buttons)
    }
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, extras)
    } catch {
      // Fallback without parse mode
      const fallbackExtras: Record<string, unknown> = {}
      if (options?.buttons?.length) {
        fallbackExtras.reply_markup = this.buildKeyboard(options.buttons)
      }
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), text, fallbackExtras).catch(() => {})
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {})
  }

  async sendFile(chatId: string, filePath: string, type: 'voice' | 'document'): Promise<void> {
    if (type === 'voice') {
      await this.bot.api.sendVoice(Number(chatId), new InputFile(filePath))
    } else {
      await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath))
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    // Telegram uses the callback query context, not a separate ID.
    // This is handled inline in the callback handler above via ctx.answerCallbackQuery.
    // For the adapter pattern, we'll need the bot API directly.
    // Since grammY ties callback answers to context, this is a no-op here.
    // The bot-core handles it via sendMessage.
    void callbackId
    void text
  }

  async clearButtons(chatId: string, messageId: string): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(Number(chatId), Number(messageId), { reply_markup: undefined })
    } catch {
      // Message may have been edited away
    }
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.bot.api.setMyCommands(commands).catch((err) => {
      logger.warn({ err }, 'Failed to register command menu')
    })
  }

  formatText(markdown: string): string {
    return formatForTelegram(markdown)
  }

  splitMessage(text: string): string[] {
    return splitMessageImpl(text, this.maxMessageLength)
  }

  // --- Private ---

  private buildKeyboard(labels: string[]): InlineKeyboard {
    const kb = new InlineKeyboard()
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
}

// --- Formatting (extracted from original bot.ts) ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Render markdown tables as aligned monospace <pre> blocks (Telegram has no native table tag).
const EXPANDABLE_QUOTE_LINES = 5

function renderMarkdownTable(block: string): string | null {
  const lines = block.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return null
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1])) return null

  const parseRow = (row: string): string[] =>
    row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

  const header = parseRow(lines[0])
  const body = lines.slice(2).map(parseRow)
  if (body.length === 0) return null

  const colCount = header.length
  const widths = new Array(colCount).fill(0)
  for (const row of [header, ...body]) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? '').length)
    }
  }
  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  const rendered = [fmtRow(header), sep, ...body.map(fmtRow)].join('\n')
  return `<pre>${escapeHtml(rendered)}</pre>`
}

function formatForTelegram(text: string): string {
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    const block = lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`
    codeBlocks.push(block)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  const inlineCode: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINE${inlineCode.length - 1}\x00`
  })

  // Detect and render markdown tables (before HTML escape eats the pipes).
  const protectedBlocks: string[] = []
  result = result.replace(
    /(^|\n)((?:\|?[^\n]+\|[^\n]+\n){1}(?:\|?\s*:?-+:?\s*\|[^\n]*\n)(?:\|?[^\n]+\|[^\n]*(?:\n|$))+)/g,
    (_match, lead, block) => {
      const rendered = renderMarkdownTable(block)
      if (!rendered) return _match
      protectedBlocks.push(rendered)
      return `${lead}\x00BLOCK${protectedBlocks.length - 1}\x00`
    }
  )

  // Detect markdown blockquotes (contiguous lines starting with `> `).
  result = result.replace(/(^|\n)((?:> ?[^\n]*(?:\n|$))+)/g, (_match, lead, block) => {
    const lines = block.replace(/\n$/, '').split('\n').map((l: string) => l.replace(/^> ?/, ''))
    const escaped = lines.map((l: string) => escapeHtml(l)).join('\n')
    const inlined = escaped
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    const tag = lines.length >= EXPANDABLE_QUOTE_LINES
      ? `<blockquote expandable>${inlined}</blockquote>`
      : `<blockquote>${inlined}</blockquote>`
    protectedBlocks.push(tag)
    return `${lead}\x00BLOCK${protectedBlocks.length - 1}\x00`
  })

  result = result.replace(/[&<>]/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    return '&gt;'
  })

  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  result = result.replace(/^- \[ \]/gm, '\u2610')
  result = result.replace(/^- \[x\]/gm, '\u2611')
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  result = result.replace(/\x00BLOCK(\d+)\x00/g, (_match, i) => protectedBlocks[Number(i)])
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, i) => codeBlocks[Number(i)])
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, i) => inlineCode[Number(i)])

  return result.trim()
}

function splitMessageImpl(text: string, limit: number): string[] {
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
