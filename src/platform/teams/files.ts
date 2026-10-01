/**
 * Sending files and images into a Teams personal chat.
 *
 * Teams has two outbound paths and they are not interchangeable:
 *
 *   Images ride along in the message itself, as a base64 data URI in an
 *   attachment's contentUrl. They render in the chat, need no permission and
 *   no storage, and Microsoft excludes base64 images from the ~100 KB message
 *   payload limit. Documented ceiling: PNG/JPEG/GIF, within 1024x1024 px and
 *   under 1 MB (learn.microsoft.com, "Format text in cards" > inline images).
 *
 *   Everything else goes through the file consent flow: the bot asks, the user
 *   says yes, Teams hands back a one-time upload URL into *the user's own*
 *   OneDrive, the bot PUTs the bytes there, and a file card appears in the
 *   chat. Personal chats only; the Teams SDK consent APIs do not work in a
 *   channel or a group chat. The app manifest has declared "supportsFiles":
 *   true since the Teams adapter shipped, which is what makes it available.
 *
 * So the choice is made by what the file is, not by caller preference: an
 * image small enough to inline should never make the owner click Allow, and
 * anything else cannot be inlined at all.
 *
 * Pure module. The adapter does the reading, sending and uploading.
 */
import { basename, extname } from 'node:path'
import type { ActivityAttachment, OutboundActivity } from './types.js'

export const FILE_CONSENT_CARD = 'application/vnd.microsoft.teams.card.file.consent'
export const FILE_INFO_CARD = 'application/vnd.microsoft.teams.card.file.info'
export const FILE_CONSENT_INVOKE = 'fileConsent/invoke'

/** Microsoft's documented ceiling for an image carried inside a message. */
export const INLINE_IMAGE_MAX_BYTES = 1_000_000

/**
 * The most we will push through a single consent upload. OneDrive's upload
 * session would take far more in fragments, but a one-shot PUT means holding
 * the whole file in memory on a 2 GB box, and an assistant with a reason to
 * send someone a 200 MB file is an assistant doing something else wrong.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).replace('.', '').toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export type Delivery =
  | { kind: 'inline'; contentType: string }
  | { kind: 'consent' }
  | { kind: 'refuse'; reason: string }

/**
 * Which path a file takes. `webp` is a real trap worth naming: browsers and
 * screenshot tools emit it happily and Teams does not render it inline, so it
 * goes the consent route rather than arriving as a broken image.
 */
export function decideDelivery(sizeInBytes: number, contentType: string): Delivery {
  if (sizeInBytes <= 0) return { kind: 'refuse', reason: 'the file is empty' }
  if (sizeInBytes > UPLOAD_MAX_BYTES) {
    return { kind: 'refuse', reason: `the file is ${mb(sizeInBytes)}, over the ${mb(UPLOAD_MAX_BYTES)} limit for sending into Teams` }
  }
  if (INLINE_IMAGE_TYPES.has(contentType) && sizeInBytes <= INLINE_IMAGE_MAX_BYTES) {
    return { kind: 'inline', contentType }
  }
  return { kind: 'consent' }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * An image in the message body. `text` rides along as the caption; Teams
 * renders it above the picture.
 */
export function inlineImageActivity(filePath: string, contentType: string, bytes: Buffer, caption?: string): OutboundActivity {
  const name = basename(filePath)
  const attachment: ActivityAttachment = {
    contentType,
    contentUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
    name,
  }
  return { type: 'message', ...(caption ? { text: caption, textFormat: 'markdown' as const } : {}), attachments: [attachment] }
}

/**
 * The permission ask. `acceptContext` and `declineContext` come back to us
 * verbatim on the invoke, so the id of the pending file rides there rather
 * than in a module-level "last file" variable that two concurrent sends would
 * race over.
 */
export function fileConsentActivity(name: string, sizeInBytes: number, pendingId: string, description: string): OutboundActivity {
  return {
    type: 'message',
    attachments: [
      {
        contentType: FILE_CONSENT_CARD,
        name,
        content: {
          description,
          sizeInBytes,
          acceptContext: { pendingId },
          declineContext: { pendingId },
        },
      },
    ],
  }
}

/** The card that appears once the bytes are in the user's OneDrive. */
export function fileInfoActivity(info: FileUploadInfo, text: string): OutboundActivity {
  return {
    type: 'message',
    text,
    textFormat: 'markdown',
    attachments: [
      {
        contentType: FILE_INFO_CARD,
        contentUrl: info.contentUrl,
        name: info.name,
        content: { uniqueId: info.uniqueId, fileType: info.fileType },
      },
    ],
  }
}

export interface FileUploadInfo {
  name: string
  uploadUrl: string
  contentUrl?: string
  uniqueId?: string
  fileType?: string
}

/**
 * Where we are willing to PUT the owner's file.
 *
 * The URL arrives inside an invoke activity. That activity is signed by the
 * Bot Framework, so it is not forgeable by a stranger, but the destination is
 * still a value handed to us by a remote party and what we do with it is
 * upload a local file. An unchecked destination is an exfiltration primitive
 * dressed as a feature, so the host is checked against the only thing a
 * consent upload is ever supposed to be: the user's own OneDrive for
 * Business, which lives under sharepoint.com.
 *
 * Deliberately narrow. A wrong refusal costs one log line and a message to
 * the owner saying the file did not send; a wrong acceptance costs the file.
 * The bot's bearer token never goes with it either: the upload URL is
 * pre-authorized, so a token would be both useless and leaked.
 */
const UPLOAD_HOST_SUFFIXES = ['.sharepoint.com']

export function isOneDriveUploadHost(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return UPLOAD_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
}

/** Headers for the one-shot upload. No Authorization, by design (see above). */
export function uploadHeaders(sizeInBytes: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(sizeInBytes),
    'Content-Range': `bytes 0-${sizeInBytes - 1}/${sizeInBytes}`,
  }
}
