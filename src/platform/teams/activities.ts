/**
 * Pure mapping between Bot Framework activities and the adapter-neutral
 * IncomingMessage / outbound shapes. No I/O here; the adapter does the
 * downloading and sending.
 */
import type { IncomingMessage } from '../types.js'
import type { Activity, ConversationReference } from './types.js'

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
