/**
 * Send a Telegram notification from the command line.
 * Usage (run compiled): node dist/scripts/notify.js "Your message here"
 *
 * Reads TELEGRAM_BOT_TOKEN (vault -> .env -> environment) and ALLOWED_CHAT_ID.
 * Useful for progress pings from long-running jobs and OS schedulers.
 */
import { sendTelegram } from '../src/notify.js'

const message = process.argv.slice(2).join(' ').trim()

if (!message) {
  console.error('Usage: notify <message>\n  Requires TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID configured.')
  process.exit(1)
}

sendTelegram(message).then((ok) => {
  if (ok) {
    console.log('Sent.')
  } else {
    console.error('Failed to send (check TELEGRAM_BOT_TOKEN / ALLOWED_CHAT_ID).')
    process.exit(1)
  }
})
