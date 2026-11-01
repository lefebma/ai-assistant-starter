/**
 * Web routes for voice chat from the chat bar (card #248). The web session is
 * the credential: same session check, isChatAllowed re-check and origin rules
 * as every other /api/web route, and a conversation of another chat is not
 * found. See voice-chat.ts for what a call does.
 */
import { registerWebRoutes, type WebContext } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { getConversation } from './conversations.js'
import { startWebCall, endWebCall, webCallStatus, VoiceChatError } from './voice-chat.js'
import { LiveSessionError, LIVE_VOICES } from '../voice-live.js'
import { logger } from '../logger.js'

/** An SDP offer is a few kilobytes. */
const MAX_OFFER_BODY = 64_000
/** How long End waits for the transcript to land before answering. */
const END_WAIT_MS = 8_000

async function jsonBody(ctx: WebContext, max?: number): Promise<Record<string, unknown>> {
  const parsed = await readJsonCapped(ctx.req, max)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError(400, 'bad_json')
  return parsed as Record<string, unknown>
}

registerWebRoutes([
  {
    // Start a call in this conversation: the browser's WebRTC offer in, the answer out.
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/voice$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      const b = await jsonBody(ctx, MAX_OFFER_BODY)
      if (typeof b.sdp !== 'string' || !b.sdp.trim()) return sendError(ctx.res, 400, 'sdp_required')
      // Card #257: an optional voice from the call bar's dropdown. Anything
      // that is not one of LIVE_VOICES is refused, not quietly swapped.
      let voice: string | undefined
      if (b.voice !== undefined && b.voice !== null && b.voice !== '') {
        if (typeof b.voice !== 'string' || !(LIVE_VOICES as readonly string[]).includes(b.voice)) return sendError(ctx.res, 400, 'invalid_voice')
        voice = b.voice
      }
      try {
        const r = await startWebCall({ chatId: ctx.chatId, conversationId: id, sdp: b.sdp, voice })
        sendJson(ctx.res, 201, r)
      } catch (err) {
        if (err instanceof VoiceChatError || err instanceof LiveSessionError) return sendError(ctx.res, err.status, err.code)
        logger.error({ err, conversationId: id }, 'web voice call failed to start')
        sendError(ctx.res, 500, 'internal_error')
      }
    },
  },
  {
    // End a call (End, or the page going away). `wait` holds the answer until
    // the transcript is in the conversation, so the page can show it.
    method: 'POST',
    pattern: /^\/api\/web\/voice\/end$/,
    auth: true,
    async handler(ctx) {
      const b = await jsonBody(ctx, 4_000)
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId : ''
      const r = sessionId ? await endWebCall(ctx.chatId, sessionId, b.wait === true ? END_WAIT_MS : 0) : null
      if (!r) return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, { ended: true, finished: r.finished, added: r.added })
    },
  },
  {
    // Is this call still open? The page asks every few seconds, because the
    // box can end a call (idle, too long, /cancel, a lost connection to the
    // voice service) without the page hearing about it.
    method: 'GET',
    pattern: /^\/api\/web\/voice\/calls\/([^/]+)$/,
    auth: true,
    handler(ctx) {
      const r = webCallStatus(ctx.chatId, ctx.params[0]!)
      if (!r) return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, r)
    },
  },
])
