/**
 * Web routes: the quiet tip card (card #273). Tips belong to the owner's main
 * chat, so another authorized chat sees none and cannot answer one.
 */
import { registerWebRoutes } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { PRIMARY_CHAT_ID } from '../config.js'
import { answerWebTip, webTip } from '../tips/control.js'

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/tips$/,
    auth: true,
    handler(ctx) {
      sendJson(ctx.res, 200, { tip: ctx.chatId === PRIMARY_CHAT_ID ? webTip() : null })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/tips$/,
    auth: true,
    async handler(ctx) {
      if (ctx.chatId !== PRIMARY_CHAT_ID) return sendError(ctx.res, 403, 'forbidden')
      let body: { action?: unknown; ids?: unknown }
      try {
        body = (await readJsonCapped(ctx.req)) as typeof body
      } catch (err) {
        return sendError(ctx.res, err instanceof BodyError ? err.status : 400, 'bad_body')
      }
      const { action, ids } = body
      if (action !== 'ok' && action !== 'hide') return sendError(ctx.res, 400, 'bad_action')
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return sendError(ctx.res, 400, 'bad_ids')
      answerWebTip(ids as string[], action === 'hide')
      sendJson(ctx.res, 200, { ok: true })
    },
  },
])
