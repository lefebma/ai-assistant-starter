import https from 'node:https'
import { createReadStream } from 'node:fs'
import FormData from 'form-data'
import { OPENAI_API_KEY } from './config.js'
import { logger } from './logger.js'

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!OPENAI_API_KEY,
    tts: !!OPENAI_API_KEY,
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

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured')
  }

  const body = JSON.stringify({
    model: 'tts-1',
    input: text,
    voice: 'fable',
    response_format: 'mp3',
  })

  return new Promise((resolve, reject) => {
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
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (res.statusCode !== 200) {
            logger.error(
              { status: res.statusCode, body: buffer.toString() },
              'OpenAI TTS failed'
            )
            reject(new Error(`OpenAI TTS returned ${res.statusCode}`))
            return
          }
          resolve(buffer)
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
