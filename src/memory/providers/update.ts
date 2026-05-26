/**
 * UpdateProvider - injects update availability into context.
 * Only fires on briefing-like messages or explicit update queries.
 * Uses cached status (4h TTL) to avoid hammering GitHub.
 */

import type { ContextProvider, ContextFragment } from './base.js'
import { checkForUpdate } from '../../updater.js'

const UPDATE_TRIGGERS = /\b(briefing|morning|update|version|status)\b/i

export class UpdateProvider implements ContextProvider {
  name = 'update'
  priority = 30
  enabled = true

  async retrieve(_chatId: string, message: string): Promise<ContextFragment[]> {
    if (!UPDATE_TRIGGERS.test(message)) return []

    const status = await checkForUpdate(true) // use cache, don't hit GitHub every message
    if (!status.updateAvailable || !status.latestVersion) return []

    return [
      {
        source: 'update',
        content: `[Update available] Current: v${status.currentVersion}, Latest: v${status.latestVersion}. User can run /update to install.`,
        relevance: 0.7,
      },
    ]
  }
}
