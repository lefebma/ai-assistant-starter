/**
 * The hand-off route (unconfigured boxes expose it as a 404), and the Gmail
 * token keeper's timer, which runs only when /connect is configured.
 */
import { SIGNATURE_HEADER, HANDOFF_PATH } from './relay.js'
import { getConnectFlow, getGmailKeeper, setGmailRevokedHandler } from './instance.js'
import { KEEPER_TICK_MS } from './gmail-token.js'
import { PRIMARY_CHAT_ID } from '../config.js'
import { registerHttpRoute, readBodyCapped } from '../http-server.js'
import { sendTelegram } from '../notify.js'
import { logger } from '../logger.js'

function startGmailKeeper(): void {
  const keeper = getGmailKeeper()
  if (!keeper) return
  setGmailRevokedHandler(async (account) => {
    logger.warn('connect: Gmail grant revoked at Google')
    await sendTelegram(`Gmail access for ${account} was withdrawn at Google, so I can no longer read or send mail there. Run /connect gmail to sign in again.`, { chatId: PRIMARY_CHAT_ID || undefined })
  })
  const tick = () => {
    keeper.tick().then(
      (r) => { if (r === 'failed') logger.warn('connect: Gmail token renewal failed, will retry') },
      (err) => logger.warn({ err: err instanceof Error ? err.message : 'error' }, 'connect: Gmail keeper error'),
    )
  }
  tick()
  setInterval(tick, KEEPER_TICK_MS).unref()
}

export function registerConnectRoute(): void {
  startGmailKeeper()
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
