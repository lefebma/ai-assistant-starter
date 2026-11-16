/**
 * The /request conversation (card #240), kept out of bot.ts so it can be
 * tested without a platform. bot.ts sends what each step returns.
 *
 *   /request <words>   tidy, then show the draft with Send / Edit / Cancel
 *   /request           ask what they would like; the next message is the request
 *   Edit               the next message replaces the request, used as written
 *
 * Nothing is sent without Send. One draft per chat at a time.
 */
import type { SendResult } from '../support/send.js'
import {
  buildRequestDraft,
  formatRequestPreview,
  MAX_REQUEST_CHARS,
  newRequestRef,
  parseTidied,
  type RequestDraft,
  type RequestSender,
} from './draft.js'
import { canSendRequest, MAX_REQUESTS_PER_DAY, recordRequest, saveFeatureRequest } from './store.js'

export const REQUEST_BUTTONS = ['Send', 'Edit', 'Cancel']

export interface RequestReply {
  text: string
  buttons?: string[]
}

export interface RequestFlowDeps {
  /** The model's tidy of the customer's words. May throw; the words are then used as written. */
  tidy(raw: string): Promise<string>
  send(draft: RequestDraft): Promise<SendResult>
  sender(): RequestSender
  to(): string
  logFile: string
  saveDir: string
  now?: () => Date
  newRef?: () => string
  logError?: (err: unknown, msg: string) => void
}

const ASK =
  'What would you like your assistant to do that it cannot do today? Describe it in your next message, and say why it would help and how often you would use it.\n(Next time you can write it straight after the command: /request <what you want>.)'

function limitReply(): RequestReply {
  return {
    text: `You have sent ${MAX_REQUESTS_PER_DAY} requests in the last day, which is the limit. Try again tomorrow, or put several ideas in one request.`,
  }
}

export class RequestFlow {
  private readonly pending = new Map<string, RequestDraft>()
  /** 'new' takes the next message and tidies it; 'edit' takes it as written. */
  private readonly awaiting = new Map<string, 'new' | 'edit'>()
  /** Bumped by clear(): a tidy that finishes after the chat moved on is dropped. */
  private readonly generation = new Map<string, number>()

  constructor(private readonly deps: RequestFlowDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * True when this text belongs to the flow: the awaited request, or, only
   * where the platform has no buttons (`typedAnswers`), a typed Send/Edit/Cancel.
   * Where there are buttons only a click on the draft's own card answers it, so
   * a "Send" typed for something else can never send the request.
   */
  owns(chatId: string, text: string, typedAnswers: boolean): boolean {
    const t = text.trim()
    return (typedAnswers && this.pending.has(chatId) && /^(send|edit|cancel)$/i.test(t)) || (this.awaiting.has(chatId) && !t.startsWith('/'))
  }

  hasDraft(chatId: string): boolean {
    return this.pending.has(chatId)
  }

  draftFor(chatId: string): RequestDraft | undefined {
    return this.pending.get(chatId)
  }

  isAwaiting(chatId: string): boolean {
    return this.awaiting.has(chatId)
  }

  clear(chatId: string): void {
    this.pending.delete(chatId)
    this.awaiting.delete(chatId)
    this.generation.set(chatId, (this.generation.get(chatId) ?? 0) + 1)
  }

  async command(chatId: string, text: string): Promise<RequestReply> {
    this.clear(chatId)
    if (!canSendRequest(this.deps.logFile, this.now())) return limitReply()
    const words = text.replace(/^\/request(@\S+)?\s*/i, '').trim()
    if (!words) {
      this.awaiting.set(chatId, 'new')
      return { text: ASK }
    }
    return this.draft(chatId, words)
  }

  /** The message an awaiting chat sent: draft it. */
  async answer(chatId: string, text: string): Promise<RequestReply> {
    const mode = this.awaiting.get(chatId) ?? 'new'
    return this.draft(chatId, text, mode === 'edit')
  }

  private async draft(chatId: string, raw: string, asWritten = false): Promise<RequestReply> {
    this.awaiting.delete(chatId)
    const words = raw.trim()
    if (words.length > MAX_REQUEST_CHARS) {
      this.awaiting.set(chatId, asWritten ? 'edit' : 'new')
      return { text: `That is ${words.length} characters. Keep it under ${MAX_REQUEST_CHARS}: send a shorter version as your next message.` }
    }
    const gen = this.generation.get(chatId) ?? 0
    let summary: string
    if (asWritten) {
      summary = words
    } else {
      try {
        summary = parseTidied(await this.deps.tidy(words), words)
      } catch (err) {
        this.deps.logError?.(err, 'request: tidy failed, using the words as written')
        summary = parseTidied('', words)
      }
    }
    // /support, /newchat or another /request arrived while the tidy ran: this
    // draft is stale, and showing it would put two drafts in one chat.
    if ((this.generation.get(chatId) ?? 0) !== gen) return { text: '' }
    const sender = this.deps.sender()
    const draft = buildRequestDraft(summary, sender, this.deps.to(), (this.deps.newRef ?? newRequestRef)())
    this.pending.set(chatId, draft)
    return { text: formatRequestPreview(draft, sender), buttons: REQUEST_BUTTONS }
  }

  /** Send / Edit / Cancel on the pending draft. Null when there is none or the action is not one of those. */
  async resolve(chatId: string, action: string): Promise<RequestReply | null> {
    const draft = this.pending.get(chatId)
    if (!draft) return null
    const a = action.trim().toLowerCase()
    if (a === 'cancel') {
      this.pending.delete(chatId)
      return { text: 'Cancelled. Nothing was sent.' }
    }
    if (a === 'edit') {
      this.pending.delete(chatId)
      this.awaiting.set(chatId, 'edit')
      return { text: 'Send the request the way you want it as your next message. I will send it as you write it.' }
    }
    if (a !== 'send') return null

    this.pending.delete(chatId)
    const now = this.now()
    if (!canSendRequest(this.deps.logFile, now)) return limitReply()
    // Counted before the send, in the same tick as the check, so two Sends
    // racing through one email window cannot both pass the limit. A request
    // that fails to send is saved below and still counts.
    recordRequest(this.deps.logFile, draft.ref, now)
    const result = await this.deps.send(draft)
    if (result.ok) {
      return { text: `Sent. The Havn team will see it. Your reference is ${draft.ref}.` }
    }
    try {
      saveFeatureRequest(draft, this.deps.saveDir)
      return {
        text: `I could not email it (${result.detail || 'no email account connected'}). It is saved on this assistant as ${draft.ref}, so nothing is lost: mention ${draft.ref} to whoever set up your assistant and they can pick it up.`,
      }
    } catch (err) {
      this.deps.logError?.(err, 'request: could not save the fallback file')
      return { text: `I could not email it or save it. Please send it to ${draft.to} yourself.` }
    }
  }
}
