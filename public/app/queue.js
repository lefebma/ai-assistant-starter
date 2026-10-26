// Messages sent while a reply is still being written (card #250). The box
// keeps them in order and runs each when the one before it finishes.

/**
 * Commands that act on the reply in progress run at once, as in Telegram.
 * Everything else sent mid-reply waits its turn. The box applies the same rule.
 */
export function runsNow(text) {
  return /^\/(cancel|steer)(?:@\S+)?(?:\s|$)/i.test((text || '').trim())
}

/** A fresh name for one message, so sending it twice cannot make two. */
export function newClientId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
}

/** The label under a waiting message. */
export function queueLabel(item, position) {
  if (item.state === 'sending') return 'Sending...'
  return position === 0 ? 'Queued, runs next' : 'Queued, ' + ordinal(position + 1) + ' in line'
}

function ordinal(n) {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return n + 'th'
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th')
}
