/**
 * Platform adapter abstraction (OpenClaw v2026.5.24).
 * Decouples the assistant engine from any specific messaging platform.
 * Implement this interface for Telegram, Slack, Discord, Teams, etc.
 */

export interface IncomingMessage {
  chatId: string
  userId: string
  text: string
  type: 'text' | 'voice' | 'photo' | 'document' | 'video' | 'callback'
  /** Local path to downloaded media file (set by adapter after download) */
  filePath?: string
  /** Original filename for documents */
  fileName?: string
  /** Caption on media messages */
  caption?: string
  /** Callback button data */
  callbackData?: string
  /** Platform-native message ID (for editing, clearing keyboards, etc.) */
  messageId?: string
  /** Raw update/event ID for replay protection */
  updateId?: string | number
}

export interface SendOptions {
  /** Parse mode: 'html', 'markdown', or platform-native */
  parseMode?: string
  /** Inline button labels (pipe-separated labels from [[buttons:...]] marker) */
  buttons?: string[]
}

export interface PlatformAdapter {
  /** Platform name for logging and config */
  readonly name: string

  /** Max message length before splitting */
  readonly maxMessageLength: number

  /** Whether the platform supports editing sent messages (for streaming previews) */
  readonly supportsEdit: boolean

  /** Whether the platform supports inline buttons / actions */
  readonly supportsButtons: boolean

  // --- Lifecycle ---

  /** Start receiving messages (polling, socket, webhook) */
  start(): Promise<void>

  /** Graceful shutdown */
  stop(): Promise<void>

  // --- Outgoing ---

  /** Send a text message. Returns platform-native message ID. */
  sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string>

  /** Edit an existing message (for streaming previews). No-op if unsupported. */
  editMessage(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void>

  /** Send typing / processing indicator */
  sendTyping(chatId: string): Promise<void>

  /** Send a file (voice reply, document, etc.) */
  sendFile(chatId: string, filePath: string, type: 'voice' | 'document'): Promise<void>

  /** Acknowledge a callback/button click */
  answerCallback(callbackId: string, text?: string): Promise<void>

  /** Remove inline buttons from a message */
  clearButtons(chatId: string, messageId: string): Promise<void>

  // --- Formatting ---

  /**
   * Convert markdown to platform-native format.
   * Telegram: HTML. Slack: mrkdwn. Discord: markdown (pass-through). Teams: Adaptive Card text.
   */
  formatText(markdown: string): string

  /**
   * Split a long message into chunks that fit the platform's length limit.
   */
  splitMessage(text: string): string[]

  // --- Events ---

  /** Register the message handler. Called by bot-core. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void

  /** Register an activity heartbeat (for watchdog). Called on every incoming event. */
  onActivity(handler: () => void): void

  /** Register native commands menu (if platform supports it) */
  setCommands?(commands: Array<{ command: string; description: string }>): Promise<void>
}

export type PlatformName = 'telegram' | 'slack' | 'discord' | 'teams'
