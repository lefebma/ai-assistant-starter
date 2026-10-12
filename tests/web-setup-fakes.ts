import type { Fetch } from '../src/setup/web/telegram.js'

export const BOT_TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake1'

interface Msg {
  chatId: number
  type?: string
  text?: string
  /** Seconds since epoch. */
  date: number
  first?: string
  username?: string
}

/** A fake Telegram Bot API plus Open-Meteo geocoding, enough for setup. */
export function fakeTelegram(opts: { badToken?: boolean; conflict?: boolean } = {}) {
  let nextId = 100
  const queue: Array<{ update_id: number; message: unknown }> = []
  const sent: Array<{ chat_id: number; text: string }> = []
  const calls: string[] = []
  const push = (m: Msg) =>
    queue.push({
      update_id: nextId++,
      message: {
        date: m.date,
        text: m.text ?? '/start',
        chat: { id: m.chatId, type: m.type ?? 'private', first_name: m.first ?? 'Leif', username: m.username },
      },
    })
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  const f: Fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
      calls.push('geocode')
      return reply({ results: [{ latitude: 43.7, longitude: -79.42, country_code: 'CA', name: 'Toronto', admin1: 'Ontario', country: 'Canada' }] })
    }
    const method = url.split('/').pop()!
    calls.push(method)
    if (opts.badToken) return reply({ ok: false, error_code: 401, description: 'Unauthorized' })
    const params = JSON.parse(String(init?.body ?? '{}')) as { offset?: number; chat_id?: number; text?: string }
    switch (method) {
      case 'getMe':
        return reply({ ok: true, result: { is_bot: true, username: 'avery_test_bot', first_name: 'Avery' } })
      case 'getUpdates': {
        if (opts.conflict) return reply({ ok: false, error_code: 409, description: 'Conflict' })
        if (params.offset === -1) return reply({ ok: true, result: queue.slice(-1) })
        const out = queue.filter((u) => u.update_id >= (params.offset ?? 0))
        if (!out.length) await new Promise((r) => setTimeout(r, 5))
        return reply({ ok: true, result: out })
      }
      case 'sendMessage':
        if (api.failSend) return reply({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })
        sent.push({ chat_id: params.chat_id!, text: params.text! })
        return reply({ ok: true, result: {} })
      default:
        return reply({ ok: false, error_code: 400, description: 'unknown' })
    }
  }
  const api = { f, push, sent, calls, failSend: false }
  return api
}
