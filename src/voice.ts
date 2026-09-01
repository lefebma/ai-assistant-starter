import https from 'node:https'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import FormData from 'form-data'
import { OPENAI_API_KEY, TTS_VOICE } from './config.js'
import { logger } from './logger.js'

/** Check if macOS `say` command is available */
function hasMacSay(): boolean {
  try {
    execFileSync('which', ['say'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const macSayAvailable = hasMacSay()

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!OPENAI_API_KEY,
    tts: !!OPENAI_API_KEY || macSayAvailable,
  }
}

export async function transcribeAudio(filePath: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured')
  }

  const form = new FormData()
  form.append('file', createReadStream(filePath))
  form.append('model', 'whisper-1')

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            logger.error({ status: res.statusCode, body: data }, 'Whisper STT failed')
            reject(new Error(`OpenAI Whisper returned ${res.statusCode}`))
            return
          }
          try {
            const json = JSON.parse(data)
            resolve(json.text || '')
          } catch {
            reject(new Error('Failed to parse Whisper response'))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    form.pipe(req)
  })
}

/** Spoken audio plus the type it actually is, which differs by engine. */
export interface SpokenAudio {
  audio: Buffer
  contentType: string
}

/**
 * OpenAI's tts-1 rejects input past 4096 characters, and macOS `say` will
 * happily read for ten minutes. Neither is a good answer to a long reply, so
 * cap here rather than in each caller.
 */
export const MAX_TTS_CHARS = 4000

export function truncateForSpeech(text: string): string {
  const t = text.trim()
  return t.length > MAX_TTS_CHARS ? `${t.slice(0, MAX_TTS_CHARS)}...` : t
}

/**
 * Speak text, and say what came back.
 *
 * Callers that write the bytes to an HTTP response need the content type: the
 * two engines do not agree on one (OpenAI returns MP3, the macOS path converts
 * to AAC in an MP4 container), and a browser handed the wrong type plays
 * nothing with no error worth reading.
 */
export async function synthesizeSpeechAudio(text: string): Promise<SpokenAudio> {
  // Prefer OpenAI TTS if available, fall back to macOS `say`
  if (OPENAI_API_KEY) {
    return { audio: await synthesizeOpenAI(truncateForSpeech(text)), contentType: 'audio/mpeg' }
  }
  if (macSayAvailable) {
    return { audio: await synthesizeMacSay(truncateForSpeech(text)), contentType: 'audio/mp4' }
  }
  throw new Error('No TTS engine available. Set OPENAI_API_KEY or run on macOS.')
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  return (await synthesizeSpeechAudio(text)).audio
}

/**
 * macOS `say` fallback TTS. Free, no API key, works on any Mac.
 * Generates AIFF via `say`, converts to MP3 via `afconvert` (also built into macOS).
 */
async function synthesizeMacSay(text: string): Promise<Buffer> {
  const { readFileSync, unlinkSync } = await import('node:fs')
  const tmpDir = resolve(process.cwd(), 'store', 'tts-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const ts = Date.now()
  const aiffPath = resolve(tmpDir, `say_${ts}.aiff`)
  const mp3Path = resolve(tmpDir, `say_${ts}.m4a`)

  try {
    // Truncate very long text to avoid `say` hanging
    const truncated = text.length > 4000 ? text.slice(0, 4000) + '...' : text

    // Generate speech as AIFF
    execFileSync('say', ['-o', aiffPath, truncated], { timeout: 30_000 })

    // Convert to M4A (AAC) using macOS built-in afconvert (Telegram accepts this)
    execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiffPath, mp3Path], {
      timeout: 15_000,
    })

    const buffer = readFileSync(mp3Path)
    logger.info({ bytes: buffer.length }, 'macOS say TTS generated')
    return buffer
  } finally {
    // Cleanup temp files
    try { unlinkSync(aiffPath) } catch {}
    try { unlinkSync(mp3Path) } catch {}
  }
}

/** OpenAI TTS-1 synthesis */
async function synthesizeOpenAI(text: string): Promise<Buffer> {
  const body = JSON.stringify({
    model: 'tts-1',
    input: text,
    voice: TTS_VOICE,
    response_format: 'mp3',
  })

  return new Promise((res, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (response.statusCode !== 200) {
            logger.error(
              { status: response.statusCode, body: buffer.toString() },
              'OpenAI TTS failed'
            )
            reject(new Error(`OpenAI TTS returned ${response.statusCode}`))
            return
          }
          res(buffer)
        })
        response.on('error', reject)
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
