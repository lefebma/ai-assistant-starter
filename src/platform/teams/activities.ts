/**
 * Pure mapping between Bot Framework activities and the adapter-neutral
 * IncomingMessage / outbound shapes. No I/O here; the adapter does the
 * downloading and sending.
 */
import type { IncomingMessage } from '../types.js'
import type { Activity, ConversationReference, OutboundActivity } from './types.js'

export type AttachmentDownload = { url: string; name: string; needsAuth: boolean; kind: 'photo' | 'document' | 'voice' }

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

/** Teams wraps the bot mention as <at>Name</at>; drop it, tidy the spaces it leaves, keep every newline. */
function stripMentions(text: string): string {
  return text
    // Consume the one space Teams inserts after the mention tag along with
    // the tag itself, instead of collapsing whitespace everywhere: a global
    // collapse also eats the leading spaces of pasted, indented code.
    .replace(/<at>[^<]*<\/at>\s?/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

const MICROSOFT_ATTACHMENT_HOSTS = ['.botframework.com', '.trafficmanager.net', '.skype.com', '.sharepoint.com', '.office.net', '.microsoft.com']

/** Only these hosts should ever see the bot's bearer token in a download request. */
export function isMicrosoftAttachmentHost(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return MICROSOFT_ATTACHMENT_HOSTS.some((suffix) => parsed.hostname.endsWith(suffix))
}

function buttonLabel(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { btn?: unknown }).btn === 'string') {
    return (value as { btn: string }).btn
  }
  return null
}

/**
 * Audio subtypes are normalised to extensions the transcription API accepts
 * (audio/mp4 is an AAC voice memo: .m4a, not .mp4).
 */
/** Extensions the transcription API accepts, for audio shared as a file. */
const AUDIO_FILE_EXTENSIONS = /\.(m4a|mp3|mp4|mpeg|mpga|wav|webm|ogg|oga|flac)$/i

const AUDIO_EXTENSIONS: Record<string, string> = {
  mp4: 'm4a',
  mpeg: 'mp3',
  mpga: 'mp3',
  'x-wav': 'wav',
}

function extensionFor(contentType: string): string {
  const [type, rawSub] = contentType.split('/')
  const sub = rawSub ?? 'bin'
  if (type === 'audio') return (AUDIO_EXTENSIONS[sub] ?? sub).replace(/[^a-z0-9]/gi, '')
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
      // Teams offers no voice-memo mic in bot chats, so voice arrives as an
      // uploaded audio file; route those to transcription instead of the
      // document path.
      const voice = AUDIO_FILE_EXTENSIONS.test(name)
      return {
        kind: 'attachment',
        download: { url: content.downloadUrl, name, needsAuth: false, kind: voice ? 'voice' : 'document' },
        base: { ...common, text: '', type: voice ? 'voice' : 'document', fileName: name, caption: text || undefined },
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
    if (att.contentType.startsWith('audio/') && att.contentUrl) {
      const name = att.name ?? `voice-${id || Date.now()}.${extensionFor(att.contentType)}`
      return {
        kind: 'attachment',
        download: { url: att.contentUrl, name, needsAuth: true, kind: 'voice' },
        base: { ...common, text: '', type: 'voice', fileName: name, caption: text || undefined },
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
  // Code must pass through untouched: stash fences and inline spans behind
  // placeholders, transform the prose, then put them back.
  const stash: string[] = []
  const keep = (s: string): string => {
    stash.push(s)
    return `\0STASH_${stash.length - 1}\0`
  }
  let out = markdown.replace(/```[\s\S]*?```/g, keep).replace(/`[^`\n]+`/g, keep)

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

  out = out.replace(/\0STASH_(\d+)\0/g, (_, i: string) => stash[Number(i)])
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
