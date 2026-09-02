import https from 'node:https'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import FormData from 'form-data'
import { OPENAI_API_KEY, TTS_VOICE } from './config.js'
import { getAppState, setAppState } from './db.js'
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

/**
 * Which engine speaks. Only OpenAI has voices worth offering a choice between:
 * macOS `say` has its own unrelated set of names, and a box with neither has
 * nothing to choose from. Anything showing a voice picker must ask first.
 */
export function ttsEngine(): 'openai' | 'macos' | null {
  if (OPENAI_API_KEY) return 'openai'
  if (macSayAvailable) return 'macos'
  return null
}

export const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const
export type OpenAIVoice = (typeof OPENAI_VOICES)[number]

export function isOpenAIVoice(voice: string): voice is OpenAIVoice {
  return (OPENAI_VOICES as readonly string[]).includes(voice)
}

/** Where a chosen voice lives. store/, so an update does not reset it. */
export const VOICE_STATE_KEY = 'tts_voice'

/**
 * The voice this box speaks in, everywhere it speaks. TTS_VOICE in .env is the
 * default and a choice made in the UI overrides it, so picking a voice on the
 * voice page changes what Telegram sounds like too. That is the point: the
 * assistant has one voice, and #116 exists because it used to have as many
 * voices as it had client devices.
 *
 * An unrecognised stored value falls back rather than throwing. It would take
 * a hand-edited database to get one, and a box that cannot speak at all is a
 * worse answer than a box speaking in its default voice.
 */
export function effectiveVoice(read: (key: string) => string | null = getAppState): string {
  const chosen = read(VOICE_STATE_KEY)
  return chosen && isOpenAIVoice(chosen) ? chosen : TTS_VOICE
}

export function setEffectiveVoice(
  voice: string,
  write: (key: string, value: string) => void = setAppState,
): void {
  if (!isOpenAIVoice(voice)) throw new Error(`Unknown voice: ${voice}`)
  write(VOICE_STATE_KEY, voice)
  logger.info({ voice }, 'TTS voice changed')
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
    voice: effectiveVoice(),
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
