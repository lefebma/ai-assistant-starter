/**
 * The hand-off route. Unconfigured boxes expose it as a 404.
 */
import { SIGNATURE_HEADER, HANDOFF_PATH } from './relay.js'
import { getConnectFlow } from './instance.js'
import { registerHttpRoute, readBodyCapped } from '../http-server.js'
import { sendTelegram } from '../notify.js'
import { logger } from '../logger.js'

export function registerConnectRoute(): void {
  registerHttpRoute('POST', HANDOFF_PATH, async (req, res) => {
    const f = getConnectFlow()
    const reply = (code: number) => { res.writeHead(code); res.end() }
    if (!f) return reply(404)
    let raw: string
    try {
      raw = await readBodyCapped(req, 16 * 1024)
    } catch {
      return reply(413)
    }
    const sig = req.headers[SIGNATURE_HEADER]
    const r = await f.acceptHandoff(raw, typeof sig === 'string' ? sig : '')
    // Log the outcome only. Never the body, which holds the tokens.
    logger.info({ status: r.status }, 'connect hand-off')
    reply(r.status)
    if (r.status === 200 && r.chatId && r.message) await sendTelegram(r.message, { chatId: r.chatId })
  })
}
