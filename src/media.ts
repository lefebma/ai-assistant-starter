import { resolve, basename, extname } from 'node:path'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { PROJECT_ROOT } from './env.js'

// Was resolve(__dirname, '..'), which compiled to dist/ — so every photo and
// voice note landed in dist/workspace/uploads, a directory the next update
// deletes wholesale. Setup creates workspace/uploads at the install root.
export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads')

// Ensure uploads dir exists
mkdirSync(UPLOADS_DIR, { recursive: true })

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  // Step 1: get file path from Telegram
  const fileInfo = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  )
  const filePath = fileInfo.result?.file_path
  if (!filePath) throw new Error('Could not get file path from Telegram')

  // Step 2: download the file
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`
  const buffer = await fetchBuffer(url)

  // Step 3: save to uploads
  const ext = extname(originalFilename ?? filePath) || extname(filePath)
  const base = sanitizeFilename(basename(originalFilename ?? filePath, ext))
  const destName = `${Date.now()}_${base}${ext}`
  const destPath = resolve(UPLOADS_DIR, destName)
  writeFileSync(destPath, buffer)

  return destPath
}

function fetchJson(url: string): Promise<{ result?: { file_path?: string } }> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()))
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo attached: ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please analyze this image.')
  return parts.join('\n')
}

export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string
): string {
  const parts = [`[Document attached: ${filename} at ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please read and analyze this document.')
  return parts.join('\n')
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [
    `[Video attached: ${localPath}]`,
    'Use the GOOGLE_API_KEY from this project\'s .env file and the Gemini API to analyze this video.',
  ]
  if (caption) parts.push(`User note: ${caption}`)
  return parts.join('\n')
}

export type AttachmentKind = 'audio' | 'animation' | 'sticker' | 'video_note'

const ATTACHMENT_HINTS: Record<AttachmentKind, string> = {
  audio: 'Transcribe or analyze this audio file as appropriate.',
  animation: 'This is a GIF / silent looping video (delivered as mp4). Describe it if useful.',
  sticker: 'This is a Telegram sticker (.webp static, .tgs animated, .webm video). Describe it if useful.',
  video_note: 'This is a round video note. Use the GOOGLE_API_KEY from this project\'s .env file and the Gemini API to analyze it if needed.',
}

/** Generic attachment message for the file types delivered outside photo/document/video. */
export function buildAttachmentMessage(kind: AttachmentKind, localPath: string, caption?: string, filename?: string): string {
  const label = kind.replace('_', ' ')
  const parts = [filename ? `[${label} attached: ${filename} at ${localPath}]` : `[${label} attached: ${localPath}]`]
  if (caption) parts.push(`User note: ${caption}`)
  parts.push(ATTACHMENT_HINTS[kind])
  return parts.join('\n')
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const files = readdirSync(UPLOADS_DIR)
    const cutoff = Date.now() - maxAgeMs
    for (const file of files) {
      const filePath = resolve(UPLOADS_DIR, file)
      try {
        const stat = statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath)
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Uploads dir may not exist yet
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Download any URL into the uploads dir. Used by adapters whose files come
 * with a plain (or bearer-authenticated) URL rather than a Telegram file id.
 */
export async function downloadToUploads(
  url: string,
  filename: string,
  headers?: Record<string, string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  maxBytes = 50 * 1024 * 1024
): Promise<string> {
  const resp = await fetchImpl(url, { headers })
  if (!resp.ok) throw new Error(`Download failed (${resp.status}) for ${url}`)
  const declaredLength = Number(resp.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Download too large (${declaredLength} bytes) for ${url}`)
  }
  // Enforce the cap as bytes arrive instead of buffering the whole response
  // first: a server that omits or understates Content-Length could otherwise
  // put an unbounded amount of data in memory before the size check ever ran.
  const chunks: Buffer[] = []
  let total = 0
  if (resp.body) {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length
      if (total > maxBytes) throw new Error(`Download too large (>${maxBytes} bytes) for ${url}`)
      chunks.push(Buffer.from(chunk))
    }
  }
  const buffer = Buffer.concat(chunks)
  const ext = extname(filename)
  const base = sanitizeFilename(basename(filename, ext))
  const destPath = resolve(UPLOADS_DIR, `${Date.now()}_${base}${ext}`)
  writeFileSync(destPath, buffer)
  return destPath
}
