/**
 * Pure mapping between Bot Framework activities and the adapter-neutral
 * IncomingMessage / outbound shapes. No I/O here; the adapter does the
 * downloading and sending.
 */
import type { IncomingMessage } from '../types.js'
import type { Activity, ConversationReference, OutboundActivity } from './types.js'

export type AttachmentDownload = { url: string; name: string; needsAuth: boolean; kind: 'photo' | 'document' }

export type InboundMapping =
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'attachment'; download: AttachmentDownload; base: IncomingMessage }
  | { kind: 'bot-added' }
  | { kind: 'ignore'; reason: string }

const TEAMS_FILE_INFO = 'application/vnd.microsoft.teams.file.download.info'

export function referenceFrom(activity: Activity): ConversationReference | null {
  const conversationId = activity.conversation?.id
  const serviceUrl = activity.serviceUrl
  if (!conversationId || !serviceUrl) return null
  return {
    conversationId,
    serviceUrl,
    botId: activity.recipient?.id ?? '',
    userId: activity.from?.aadObjectId ?? activity.from?.id ?? '',
    tenantId: activity.conversation?.tenantId ?? activity.channelData?.tenant?.id,
  }
}

/** Teams wraps the bot mention as <at>Name</at>; strip it and surrounding space. */
function stripMentions(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/g, '').replace(/\s+/g, ' ').trim()
}

function buttonLabel(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { btn?: unknown }).btn === 'string') {
    return (value as { btn: string }).btn
  }
  return null
}

function extensionFor(contentType: string): string {
  const sub = contentType.split('/')[1] ?? 'bin'
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '')
}

export function mapInbound(activity: Activity, botId: string): InboundMapping {
  if (activity.type === 'conversationUpdate') {
    const added = activity.membersAdded?.some((m) => m.id === botId) ?? false
    return added ? { kind: 'bot-added' } : { kind: 'ignore', reason: 'conversationUpdate without the bot' }
  }
  if (activity.type !== 'message') return { kind: 'ignore', reason: `activity type ${activity.type}` }

  const ref = referenceFrom(activity)
  if (!ref) return { kind: 'ignore', reason: 'message without conversation/serviceUrl' }

  const id = activity.id ?? ''
  const common = { chatId: ref.conversationId, userId: ref.userId, messageId: id, updateId: id }
  const text = stripMentions(activity.text ?? '')

  const label = buttonLabel(activity.value)
  if (label) {
    return {
      kind: 'message',
      message: {
        ...common,
        text: label,
        type: 'callback',
        callbackData: `btn:${label}`,
        messageId: activity.replyToId ?? id,
      },
    }
  }

  for (const att of activity.attachments ?? []) {
    if (att.contentType === TEAMS_FILE_INFO) {
      const content = (att.content ?? {}) as { downloadUrl?: string }
      if (!content.downloadUrl) continue
      const name = att.name ?? 'file'
      return {
        kind: 'attachment',
        download: { url: content.downloadUrl, name, needsAuth: false, kind: 'document' },
        base: { ...common, text: '', type: 'document', fileName: name, caption: text || undefined },
      }
    }
    if (att.contentType.startsWith('image/') && att.contentUrl) {
      const name = att.name ?? `image-${id || Date.now()}.${extensionFor(att.contentType)}`
      return {
        kind: 'attachment',
        download: { url: att.contentUrl, name, needsAuth: true, kind: 'photo' },
        base: { ...common, text: '', type: 'photo', fileName: name, caption: text || undefined },
      }
    }
    // text/html and card echoes duplicate activity.text; fall through.
  }

  if (!text) return { kind: 'ignore', reason: 'empty message' }
  return { kind: 'message', message: { ...common, text, type: 'text' } }
}

const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive'

/**
 * Teams bot text renders a Markdown subset: bold, italic, strikethrough,
 * inline code, fenced code, links, lists. No headings, no tables, no HTML.
 * The bot core produces Markdown, and a few HTML tags left over from the
 * Telegram path; both are normalised here.
 */
export function formatForTeams(markdown: string): string {
  let out = markdown

  // HTML leftovers from the Telegram formatter → Markdown
  out = out.replace(/<b>(.*?)<\/b>/gs, '**$1**')
  out = out.replace(/<strong>(.*?)<\/strong>/gs, '**$1**')
  out = out.replace(/<i>(.*?)<\/i>/gs, '*$1*')
  out = out.replace(/<em>(.*?)<\/em>/gs, '*$1*')
  out = out.replace(/<code>(.*?)<\/code>/gs, '`$1`')
  out = out.replace(/<pre>(.*?)<\/pre>/gs, '```\n$1\n```')
  out = out.replace(/<a href="([^"]+)">(.*?)<\/a>/gs, '[$2]($1)')

  // Markdown tables → fenced block (Teams renders pipes literally otherwise)
  out = out.replace(/((?:^\|.*\|\s*$\n?){2,})/gm, (table) => '```\n' + table.trimEnd() + '\n```\n')

  // Headings → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')

  // __bold__ → **bold**
  out = out.replace(/__(.+?)__/g, '**$1**')

  return out.trim()
}

export function buildTextActivity(text: string): OutboundActivity {
  return { type: 'message', text, textFormat: 'markdown' }
}

/** Replacing a card with plain text is how buttons are "cleared". */
export function buildClearedCardActivity(text: string): OutboundActivity {
  return buildTextActivity(text)
}

export function buildTypingActivity(): OutboundActivity {
  return { type: 'typing' }
}

/**
 * One Adaptive Card: the text as a wrapping TextBlock, one Action.Submit per
 * label. `msteams.type = messageBack` makes the click arrive as a normal
 * message activity carrying `value.btn`, which mapInbound turns into the
 * callback shape the bot core already handles. `btn` is duplicated at the top
 * level of `data` because Teams merges `data` into `value` on the way back.
 */
export function buildCardActivity(text: string, buttons: string[]): OutboundActivity {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [{ type: 'TextBlock', text, wrap: true }],
    actions: buttons.map((label) => ({
      type: 'Action.Submit',
      title: label,
      data: { msteams: { type: 'messageBack', text: label, displayText: label, value: { btn: label } }, btn: label },
    })),
  }
  return { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD, content: card }] }
}
