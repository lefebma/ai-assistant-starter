/**
 * Photos the owner sent reach the model as images, not just a path (card #249).
 *
 * Telegram and the web app both hand the agent `[Photo attached: <path>]`.
 * The Claude runtime opens that with its Read tool; this runtime has no tool
 * that returns an image, so the model only ever saw the path. This turns each
 * such line into an image part on the turn's user message.
 *
 * Only files inside the uploads folder are read, so text that merely looks
 * like an attachment line cannot pull in any other file. The parts ride on
 * this turn's request only: the saved session keeps the text, so history does
 * not grow by the image every turn after.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, relative, isAbsolute } from 'node:path'
import type { ImagePart, TextPart } from 'ai'
import { UPLOADS_DIR } from '../../media.js'

/** Anthropic's per-image limit; the strictest of the providers wired here. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 10

const MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const PHOTO_LINE = /^\[Photo attached: (.+)\]$/gm

function insideUploads(real: string, uploadsDir: string): boolean {
  let root: string
  try {
    root = realpathSync(uploadsDir)
  } catch {
    return false
  }
  const rel = relative(root, real)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The user message content for this turn: the text unchanged when it attaches
 * no readable photo, else the text followed by one image part per photo.
 */
export function withAttachedImages(message: string, uploadsDir: string = UPLOADS_DIR): string | Array<TextPart | ImagePart> {
  const images: ImagePart[] = []
  const notes: string[] = []
  for (const m of message.matchAll(PHOTO_LINE)) {
    const path = m[1]!.trim()
    const mediaType = MEDIA_TYPE[extname(path).toLowerCase()]
    if (!mediaType || !existsSync(path)) continue
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      continue
    }
    if (!insideUploads(real, uploadsDir)) continue
    if (images.length >= MAX_IMAGES) {
      notes.push(`(Only the first ${MAX_IMAGES} images are shown to you; ${path} is not.)`)
      continue
    }
    const size = statSync(real).size
    if (size > MAX_IMAGE_BYTES) {
      notes.push(`(The image at ${path} is over 5 MB, so it could not be shown to you directly.)`)
      continue
    }
    images.push({ type: 'image', image: readFileSync(real), mediaType })
  }
  if (!images.length && !notes.length) return message
  const text = notes.length ? `${message}\n\n${notes.join('\n')}` : message
  return images.length ? [{ type: 'text', text }, ...images] : text
}
