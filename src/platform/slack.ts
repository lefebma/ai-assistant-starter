/**
 * Slack adapter using Bolt SDK (Socket Mode).
 * No public endpoint needed -- connects via WebSocket.
 */

import { logger } from '../logger.js'
import type { PlatformAdapter, IncomingMessage, SendOptions } from './types.js'

// Bolt is an optional dependency. Import dynamically so the app
// doesn't crash at startup if @slack/bolt isn't installed.
let BoltApp: any
let boltLoaded = false

async function loadBolt(): Promise<void> {
  if (boltLoaded) return
  try {
    const bolt = await import('@slack/bolt')
    BoltApp = bolt.App
    boltLoaded = true
  } catch {
    throw new Error(
      '@slack/bolt is not installed. Run: npm install @slack/bolt\n' +
      'Then set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env'
    )
  }
}

export class SlackAdapter implements PlatformAdapter {
  readonly name = 'slack' as const
  readonly maxMessageLength = 40000 // Slack's actual limit is ~40k for text
  readonly supportsEdit = true
  readonly supportsButtons = true

  private app: any = null
  private botToken: string
  private appToken: string
  private allowedUsers: Set<string>
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private activityHandler: (() => void) | null = null

  constructor(botToken: string, appToken: string, allowedUsers?: string) {
    this.botToken = botToken
    this.appToken = appToken
    this.allowedUsers = new Set(
      (allowedUsers ?? '').split(',').map((u) => u.trim()).filter(Boolean)
    )
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onActivity(handler: () => void): void {
    this.activityHandler = handler
  }

  async start(): Promise<void> {
    await loadBolt()

    this.app = new BoltApp({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    })

    // DMs and mentions
    this.app.message(async ({ message, say }: any) => {
      this.activityHandler?.()

      // Skip bot messages, edits, and thread broadcasts
      if (message.subtype) return

      const userId = message.user ?? ''
      if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
        logger.warn({ userId }, 'Unauthorized Slack user')
        return
      }

      // Use DM channel or thread for reply context
      const chatId = message.channel ?? ''

      // Handle file attachments
      if (message.files?.length > 0) {
        const file = message.files[0]
        const localPath = await this.downloadSlackFile(file.url_private)
        const type = this.inferFileType(file.mimetype ?? '')
        await this.messageHandler?.({
          chatId,
          userId,
          text: message.text ?? '',
          type,
          filePath: localPath,
          fileName: file.name ?? 'file',
          caption: message.text ?? undefined,
        })
        return
      }

      await this.messageHandler?.({
        chatId,
        userId,
        text: message.text ?? '',
        type: 'text',
      })
    })

    // Button/action clicks
    this.app.action(/^btn:/, async ({ action, ack, body }: any) => {
      await ack()
      this.activityHandler?.()

      const label = (action.value ?? action.action_id ?? '').replace(/^btn:/, '')
      const chatId = body.channel?.id ?? body.user?.id ?? ''
      const userId = body.user?.id ?? ''

      await this.messageHandler?.({
        chatId,
        userId,
        text: `btn:${label}`,
        type: 'callback',
        callbackData: `btn:${label}`,
        messageId: body.message?.ts ?? '',
      })
    })

    await this.app.start()
    logger.info('Slack adapter started (Socket Mode)')
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop()
    }
  }

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string> {
    const blocks: any[] = []

    // Add button blocks if requested
    if (options?.buttons?.length) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text },
      })
      blocks.push({
        type: 'actions',
        elements: options.buttons.map((label) => ({
          type: 'button',
          text: { type: 'plain_text', text: label },
          action_id: `btn:${label}`,
          value: `btn:${label}`,
        })),
      })
    }

    const result = await this.app.client.chat.postMessage({
      channel: chatId,
      text, // fallback text
      ...(blocks.length > 0 ? { blocks } : {}),
    })

    return result.ts ?? ''
  }

  async editMessage(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void> {
    const extras: Record<string, unknown> = {}

    if (options?.buttons?.length) {
      extras.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: options.buttons.map((label) => ({
            type: 'button',
            text: { type: 'plain_text', text: label },
            action_id: `btn:${label}`,
            value: `btn:${label}`,
          })),
        },
      ]
    }

    try {
      await this.app.client.chat.update({
        channel: chatId,
        ts: messageId,
        text,
        ...extras,
      })
    } catch (err) {
      logger.debug({ err }, 'Slack message edit failed')
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    // Slack doesn't have a direct "typing" indicator API for bots.
    // We could post an ephemeral "thinking..." but that's noisy.
    // No-op for now.
    void chatId
  }

  async sendFile(chatId: string, filePath: string, type: 'voice' | 'document'): Promise<void> {
    const { createReadStream } = await import('node:fs')
    await this.app.client.files.uploadV2({
      channel_id: chatId,
      file: createReadStream(filePath),
      filename: type === 'voice' ? 'voice-reply.mp3' : 'file',
    })
  }

  async answerCallback(_callbackId: string, _text?: string): Promise<void> {
    // Handled by ack() in the action handler
  }

  async clearButtons(chatId: string, messageId: string): Promise<void> {
    try {
      // Fetch current message to preserve text, then update without actions block
      const result = await this.app.client.conversations.history({
        channel: chatId,
        latest: messageId,
        inclusive: true,
        limit: 1,
      })
      const msg = result.messages?.[0]
      if (msg) {
        await this.app.client.chat.update({
          channel: chatId,
          ts: messageId,
          text: msg.text ?? '',
          blocks: [], // Remove all blocks including buttons
        })
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to clear Slack buttons')
    }
  }

  async setCommands(_commands: Array<{ command: string; description: string }>): Promise<void> {
    // Slack doesn't have a dynamic command menu like Telegram.
    // Slash commands are registered in the app manifest.
  }

  formatText(markdown: string): string {
    return formatForSlack(markdown)
  }

  splitMessage(text: string): string[] {
    if (text.length <= this.maxMessageLength) return [text]
    // Slack's limit is generous, but split if needed
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= this.maxMessageLength) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', this.maxMessageLength)
      if (splitAt < this.maxMessageLength * 0.5) splitAt = this.maxMessageLength
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    return chunks
  }

  // --- Private ---

  private async downloadSlackFile(url: string): Promise<string> {
    const { writeFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { UPLOADS_DIR } = await import('../media.js')

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    const filename = `slack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const localPath = resolve(UPLOADS_DIR, filename)
    writeFileSync(localPath, buffer)
    return localPath
  }

  private inferFileType(mimetype: string): IncomingMessage['type'] {
    if (mimetype.startsWith('audio/')) return 'voice'
    if (mimetype.startsWith('image/')) return 'photo'
    if (mimetype.startsWith('video/')) return 'video'
    return 'document'
  }
}

// --- Slack mrkdwn formatting ---

function formatForSlack(markdown: string): string {
  let result = markdown

  // Code blocks: keep as-is (Slack uses same ``` syntax)
  // Inline code: keep as-is (Slack uses same ` syntax)

  // Bold: **text** or __text__ -> *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')
  result = result.replace(/__(.+?)__/g, '*$1*')

  // Italic: *text* (single) -> _text_ (Slack italic)
  // This is tricky because we just converted **->* above.
  // Slack uses _text_ for italic, which conflicts with markdown _.
  // Leave single * as-is since Slack interprets them as bold anyway.

  // Strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~')

  // Links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Headings: # text -> *text* (bold, since Slack has no headings)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  return result.trim()
}
