/**
 * Out-of-band Telegram notification for scripts and jobs (sync failures,
 * dream failures, ad-hoc progress pings). Goes straight to the Telegram API,
 * not through the bot pipeline, so it works even when the service is down —
 * which is exactly when most of these fire.
 *
 * Token resolves through the vault (unlike the old notify.sh, which grepped
 * .env and silently broke once the token was migrated into the vault).
 */
import { readEnvFile } from './env.js'
import { getSecret } from './vault/index.js'

export interface SendTelegramOptions {
  token?: string
  chatId?: string
  fetchImpl?: typeof fetch
}

export async function sendTelegram(text: string, opts: SendTelegramOptions = {}): Promise<boolean> {
  const token = opts.token ?? getSecret('TELEGRAM_BOT_TOKEN') ?? ''
  const chatId = opts.chatId ?? readEnvFile()['ALLOWED_CHAT_ID'] ?? process.env.ALLOWED_CHAT_ID ?? ''
  const fetchImpl = opts.fetchImpl ?? fetch
  if (!token || !chatId || !text) return false

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}
