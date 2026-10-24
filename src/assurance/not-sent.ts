/**
 * A send failure the destination confirmed: it answered and did not take the
 * message. Senders mark their errors with this so the effect journal (card
 * #229) can let a retry through. Anything unmarked (a timeout, a dropped
 * connection) is treated as "may have gone out". Kept apart from the journal
 * so a mail client can mark errors without loading the database.
 */
export function markNotSent<E extends Error>(err: E): E {
  ;(err as E & { notSent?: boolean }).notSent = true
  return err
}

export function wasNotSent(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { notSent?: boolean }).notSent === true)
}
