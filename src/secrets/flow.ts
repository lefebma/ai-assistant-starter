/**
 * The /secret chat command: how a client on a hosted box gets an API key into
 * the encrypted vault without SSH.
 *
 * The property everything here protects: the key value never reaches the AI
 * model. The flow is handled entirely in bot code — the value is captured
 * from the next message (or inline), validated against its provider, written
 * to the vault, and the caller is told to delete the client's message from
 * the chat. Replies only ever contain a masked tail of the value.
 *
 * Capture state is in-memory and expires: a stale pending entry must not
 * swallow an unrelated message hours later. An expired or mid-capture message
 * still gets deleted — by the time we see it, it probably IS a key.
 */
import { SecretVault } from '../vault/store.js'
import { defaultVault } from '../vault/index.js'
import { createValidator, type ValidateFn, type ValidationResult } from './validate.js'

export type { ValidationResult, ValidateFn } from './validate.js'

/** Names the engine actually resolves through the vault (see docs/VAULT.md). */
export const KNOWN_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'HTTP_BEARER_TOKEN',
] as const

const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/
const DEFAULT_TTL_MS = 3 * 60_000

export function maskSecret(value: string): string {
  const v = value.trim()
  if (v.length < 9) return '••••••'
  return `••••${v.slice(-4)}`
}

export interface CommandOutcome {
  reply: string
  /** The user's message contains a secret value and must be deleted from the chat. */
  deleteUserMessage?: boolean
}

export interface CaptureOutcome {
  reply: string
  saved: boolean
  deleteUserMessage: boolean
}

interface Pending {
  name: string
  expiresAt: number
}

export interface SecretFlowOpts {
  vault?: () => SecretVault
  validate?: ValidateFn
  now?: () => number
  ttlMs?: number
}

const USAGE = [
  'Manage API keys (stored in the encrypted vault, never shown to the AI model):',
  '',
  '/secret set <NAME> - store a key; I ask for the value as your next message',
  '/secret list - show stored key names (values are never shown)',
  '/secret rm <NAME> - remove a key',
  '/secret cancel - abort a pending /secret set',
  '',
  `Keys the engine reads: ${KNOWN_SECRET_NAMES.join(', ')}`,
].join('\n')

export class SecretFlow {
  private readonly vault: () => SecretVault
  private readonly validate: ValidateFn
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly pending = new Map<string, Pending>()

  constructor(opts: SecretFlowOpts = {}) {
    this.vault = opts.vault ?? defaultVault
    this.validate = opts.validate ?? createValidator()
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  hasPending(chatId: string): boolean {
    const p = this.pending.get(chatId)
    if (!p) return false
    if (this.now() > p.expiresAt) {
      this.pending.delete(chatId)
      return false
    }
    return true
  }

  /** Clear any pending capture (e.g. an unrelated command arrived mid-flow). */
  cancelPending(chatId: string): boolean {
    return this.pending.delete(chatId)
  }

  /** Handle a '/secret ...' command message. */
  async handleCommand(chatId: string, text: string): Promise<CommandOutcome> {
    const parts = text.trim().split(/\s+/)
    const sub = (parts[1] ?? '').toLowerCase()

    if (sub === 'list') {
      const names = this.vault().list()
      if (names.length === 0) return { reply: 'No secrets in the vault yet. Add one with /secret set <NAME>.' }
      return { reply: `Stored keys (values are never shown):\n${names.map((n) => `- ${n}`).join('\n')}` }
    }

    if (sub === 'cancel') {
      const had = this.cancelPending(chatId)
      return { reply: had ? 'Cancelled. Nothing was saved.' : 'Nothing to cancel.' }
    }

    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      const name = (parts[2] ?? '').toUpperCase()
      if (!NAME_RE.test(name)) return { reply: 'Usage: /secret rm <NAME>' }
      const removed = this.vault().delete(name)
      return {
        reply: removed
          ? `${name} removed from the vault. Anything still set in .env keeps working.`
          : `${name} is not in the vault.`,
      }
    }

    if (sub === 'set' || sub === 'add') {
      const name = (parts[2] ?? '').toUpperCase()
      if (!NAME_RE.test(name)) {
        return {
          reply:
            'That does not look like a valid secret name. Use uppercase letters, digits and ' +
            'underscores, e.g. /secret set OPENAI_API_KEY',
        }
      }
      const inlineValue = parts.slice(3).join(' ').trim()
      if (inlineValue) {
        const outcome = await this.store(chatId, name, inlineValue, { keepPendingOnInvalid: false })
        return { reply: outcome.reply, deleteUserMessage: true }
      }
      this.pending.set(chatId, { name, expiresAt: this.now() + this.ttlMs })
      const minutes = Math.round(this.ttlMs / 60_000)
      return {
        reply:
          `Send the key for ${name} as your next message.\n\n` +
          'It goes straight into the encrypted vault - it is never shown to the AI model, ' +
          'and I will delete your message from the chat right after.\n' +
          `Send /secret cancel to abort. This request expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      }
    }

    return { reply: USAGE }
  }

  /**
   * Offer a non-command text message to the flow. Returns null when no capture
   * is pending for this chat (the message is not ours). Otherwise the message
   * is consumed — it must never reach the model, and the caller must delete it
   * from the chat when the outcome says so.
   */
  async capture(chatId: string, text: string): Promise<CaptureOutcome | null> {
    const p = this.pending.get(chatId)
    if (!p) return null
    if (this.now() > p.expiresAt) {
      this.pending.delete(chatId)
      return {
        saved: false,
        deleteUserMessage: true,
        reply:
          `That /secret set ${p.name} request expired - nothing was saved. ` +
          'I am deleting your message anyway. Run the command again when ready.',
      }
    }
    const value = text.trim()
    if (!value) {
      return { saved: false, deleteUserMessage: false, reply: `Empty message. Send the key for ${p.name}, or /secret cancel.` }
    }
    const outcome = await this.store(chatId, p.name, value, { keepPendingOnInvalid: true })
    return { ...outcome, deleteUserMessage: true }
  }

  /** Validate and persist. Shared by inline set and capture. */
  private async store(
    chatId: string,
    name: string,
    value: string,
    opts: { keepPendingOnInvalid: boolean }
  ): Promise<{ reply: string; saved: boolean }> {
    const result = await this.validate(name, value)

    if (result.status === 'invalid') {
      if (!opts.keepPendingOnInvalid) this.pending.delete(chatId)
      return {
        saved: false,
        reply:
          `That key was rejected by the provider (${result.detail ?? 'auth failed'}) - nothing was saved.` +
          (opts.keepPendingOnInvalid
            ? ' Paste the correct key, or send /secret cancel.'
            : ` Run /secret set ${name} to try again.`),
      }
    }

    this.vault().set(name, value)
    this.pending.delete(chatId)

    const lines = [`${name} saved to the encrypted vault (${maskSecret(value)}).`]
    if (result.status === 'unverified' && (KNOWN_SECRET_NAMES as readonly string[]).includes(name)) {
      lines.push(`Could not verify it with the provider (${result.detail ?? 'unknown'}), so double-check it works.`)
    }
    if (!(KNOWN_SECRET_NAMES as readonly string[]).includes(name)) {
      lines.push(
        'Note: this is not a key the engine reads from the vault, so nothing picks it up automatically.'
      )
    }
    lines.push('The model provider uses it immediately; other features pick it up on the next service restart.')
    return { saved: true, reply: lines.join('\n') }
  }
}
