/**
 * Web route for dictation (card #252): a recording from the chat box goes in,
 * the words come back. The recording is written to a temp file only because
 * the transcription call reads one, and that file is deleted whether or not
 * transcription works. Nothing is stored and nothing enters the conversation:
 * the words land in the owner's message box for them to review.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerWebRoutes } from './http.js'
import { sendJson, sendError } from './respond.js'
import { streamToFile, tooLarge, safeUnlink } from './file-routes.js'
import { dictationDeps, DICTATION_LEFTOVER_MS, DICTATION_TIMEOUT_MS, MAX_DICTATION_BYTES } from './dictation.js'
import { audioExtension } from '../voice.js'
import { logger } from '../logger.js'

/** Chats with a dictation being transcribed: one at a time each, so a burst of uploads cannot pile up paid calls. */
const busy = new Set<string>()

/** Delete recordings a restart left behind mid-transcription. */
function sweepLeftovers(dir: string, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith('dictation-')) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > DICTATION_LEFTOVER_MS) safeUnlink(path)
    } catch {
      // gone already
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('transcription timed out'), { timedOut: true })), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

registerWebRoutes([
  {
    method: 'POST',
    pattern: /^\/api\/web\/dictation$/,
    auth: true,
    upload: true,
    async handler(ctx) {
      const { req, res } = ctx
      const deps = dictationDeps()
      if (!deps.canTranscribe()) {
        req.resume()
        return sendError(res, 503, 'transcription_unavailable')
      }
      const ct = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (!ct.startsWith('audio/')) {
        req.resume()
        return sendError(res, 415, 'unsupported_media_type')
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_DICTATION_BYTES) return tooLarge(req, res)

      if (busy.has(ctx.chatId)) {
        req.resume()
        return sendError(res, 429, 'dictation_busy')
      }
      busy.add(ctx.chatId)
      try {
        mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 })
        sweepLeftovers(deps.tmpDir)
        // Whisper picks its decoder from the extension, so it must match what was recorded.
        const tmp = join(deps.tmpDir, `dictation-${randomBytes(8).toString('hex')}.${audioExtension(ct)}`)
        const outcome = await streamToFile(req, tmp, MAX_DICTATION_BYTES)
        if (outcome === 'too_large') return tooLarge(req, res)
        if (outcome === 'error') return sendError(res, 400, 'upload_failed')
        try {
          if (statSync(tmp).size === 0) return sendError(res, 400, 'empty_audio')
          const text = (await withTimeout(deps.transcribe(tmp), deps.timeoutMs ?? DICTATION_TIMEOUT_MS)).trim()
          sendJson(res, 200, { text })
        } catch (err) {
          logger.error({ err }, 'web dictation failed')
          if ((err as { timedOut?: boolean }).timedOut) sendError(res, 504, 'transcription_timeout')
          else sendError(res, 502, 'transcription_failed')
        } finally {
          safeUnlink(tmp)
        }
      } finally {
        busy.delete(ctx.chatId)
      }
    },
  },
])
