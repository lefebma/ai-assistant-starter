/**
 * The clock line every agent run starts with.
 *
 * Claude Code states the date but not the weekday, and a model works the
 * weekday out for itself and gets it wrong (a hosted owner was told Monday
 * 16 November was a Sunday, with "tomorrow, Tuesday" in the same reply). So
 * every run is told the weekday, date, time and zone, and what tomorrow is,
 * in the install's own timezone.
 */
import { installTimezone } from './env.js'

export function clockLine(at: Date = new Date(), timeZone: string = installTimezone()): string {
  const today = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(at)
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
  // Tomorrow is the next calendar day here, counted on the local date so a
  // daylight-saving change cannot skip or repeat a day.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const next = new Date(Date.UTC(n('year'), n('month') - 1, n('day') + 1))
  const sameYear = next.getUTCFullYear() === n('year')
  const tomorrow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(next)
  return `[Now: ${today}, ${time} (${timeZone}). Tomorrow is ${tomorrow}. Use these days of the week; do not work them out.]`
}
