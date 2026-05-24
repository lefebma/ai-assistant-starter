import { resolve, dirname, basename, extname } from 'node:path'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
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
