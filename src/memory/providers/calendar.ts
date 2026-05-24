import { execFileSync } from 'node:child_process'
import type { ContextProvider, ContextFragment } from './base.js'

/**
 * Calendar provider - injects today's schedule into context.
 * Pulls from Google Calendar via gog CLI.
 * Caches for 15 minutes to avoid hammering the API.
 */
export class CalendarProvider implements ContextProvider {
  name = 'calendar'
  priority = 70 // High priority, schedule is usually relevant
  enabled = true

  private cache: { content: string; fetchedAt: number } | null = null
  private cacheTtl = 900_000 // 15 minutes

  async retrieve(_chatId: string, message: string): Promise<ContextFragment[]> {
    // Only inject when message seems time/schedule related
    const scheduleKeywords = /\b(today|schedule|calendar|meeting|appointment|free|busy|plan|day|morning|afternoon|evening|tonight|tomorrow)\b/i
    if (!scheduleKeywords.test(message)) return []

    const now = Date.now()

    if (this.cache && now - this.cache.fetchedAt < this.cacheTtl) {
      return [
        {
          source: this.name,
          content: this.cache.content,
          relevance: 0.8,
        },
      ]
    }

    try {
      // Calendar account configured via CALENDAR_ACCOUNT env var
      const account = process.env['CALENDAR_ACCOUNT'] ?? ''
      if (!account) return []

      const events = execFileSync(
        '/opt/homebrew/bin/gog',
        ['calendar', 'events', '--account', account],
        { timeout: 10_000, encoding: 'utf-8' }
      ).trim()

      if (!events || events.length < 10) return []

      // Truncate to reasonable size
      const content = `[Today's calendar] ${events.slice(0, 800)}`
      this.cache = { content, fetchedAt: now }

      return [
        {
          source: this.name,
          content,
          relevance: 0.8,
        },
      ]
    } catch {
      return []
    }
  }
}
