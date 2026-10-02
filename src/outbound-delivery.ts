/**
 * Delivering a reply that carries files, for every surface that sends one.
 *
 * This lived inside bot.ts, which made it interactive-only: the scheduler
 * sends task output straight through adapter.sendMessage, so a [[file:]] in a
 * scheduled reply reached the chat as literal text. The jobs most likely to
 * produce a file (a morning briefing with a chart, a monthly audit as a PDF)
 * are exactly the ones with nobody there to ask for it, so the marker has to
 * work when no human is in the loop.
 */
import { PROJECT_ROOT } from './env.js'
import { UPLOADS_DIR } from './media.js'
import { logger } from './logger.js'
import { extractFileMarkers, resolveOutboundFile, type OutboundFileRequest } from './outbound-files.js'
import type { PlatformAdapter } from './platform/types.js'

/**
 * Hand over the files a reply asked for.
 *
 * Each one is resolved independently and a refusal is reported rather than
 * swallowed: "here is the report" with no report attached is worse than a
 * line saying why it did not come. A send that throws (platform rejected it,
 * network gone) gets the same treatment, because the owner is looking at the
 * message that promised the file.
 */
export async function deliverFiles(
  adapter: PlatformAdapter,
  chatId: string,
  requests: OutboundFileRequest[]
): Promise<void> {
  for (const { requested } of requests) {
    const resolved = resolveOutboundFile(requested, { projectRoot: PROJECT_ROOT, uploadsDir: UPLOADS_DIR })
    if (!resolved.ok) {
      logger.warn({ requested, reason: resolved.reason }, 'refused to send a file')
      await adapter.sendMessage(chatId, `I could not send ${requested}: ${resolved.reason}.`)
      continue
    }
    try {
      await adapter.sendFile(chatId, resolved.path, resolved.kind)
    } catch (err) {
      logger.error({ err, path: resolved.path }, 'sending a file failed')
      await adapter.sendMessage(chatId, `${resolved.name} did not send. It is on my machine at ${resolved.path}`)
    }
  }
}

/**
 * Text then files, for a sender with no interactive machinery around it (the
 * scheduler). bot.ts does not use this: its own path has a streaming preview
 * to replace and buttons to attach, so it drives the pieces itself.
 */
export async function sendTextWithFiles(adapter: PlatformAdapter, chatId: string, text: string): Promise<void> {
  const { cleanText, requests } = extractFileMarkers(text)
  // Empty chunks are dropped rather than sent. A reply that was nothing but a
  // marker leaves no text behind, and an empty send is not a no-op: Teams
  // answers 400 BadSyntax, which would throw past the delivery below and lose
  // the file the message existed to carry.
  const chunks = adapter.splitMessage(adapter.formatText(cleanText)).filter((chunk) => chunk.trim().length > 0)
  for (const chunk of chunks) {
    try {
      await adapter.sendMessage(chatId, chunk, { parseMode: 'html' })
    } catch (err) {
      try {
        await adapter.sendMessage(chatId, chunk)
      } catch (plainErr) {
        if (requests.length === 0) throw plainErr
        logger.error({ err: plainErr, chatId }, 'sending the reply text failed; delivering the files anyway')
      }
    }
  }
  if (requests.length > 0) await deliverFiles(adapter, chatId, requests)
}
