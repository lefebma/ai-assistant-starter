/**
 * Wall-clock arithmetic for Graph, which speaks UTC unless told otherwise.
 *
 * Two traps this exists to close. calendarView reads a start or end with no
 * offset as UTC, so "today" sent as a bare date is 8pm yesterday to 8pm today
 * for an owner in Toronto. And event and message times come back in UTC, so
 * printing them as-is puts a 9am meeting at 13:00. Both are converted here,
 * with Intl, rather than by asking Graph for a zone through a header whose
 * accepted names we cannot check from this side.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date in YYYY-MM-DD form. */
export function isDay(s: string): boolean {
  if (!DAY.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10)
}

function parts(instant: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {}
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  for (const p of fmt.formatToParts(instant)) out[p.type] = p.value
  return out
}

/** The date it is where the owner lives, not where the server is. */
export function localDay(now: Date, timeZone: string): string {
  const p = parts(now, timeZone)
  return `${p['year']}-${p['month']}-${p['day']}`
}

/** Minutes east of UTC in that zone at that instant (Toronto in summer: -240). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (!m) return 0 // plain "GMT"
  const mins = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -mins : mins
}

function formatOffset(mins: number): string {
  const sign = mins < 0 ? '-' : '+'
  const abs = Math.abs(mins)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * Local midnight of `day` as an ISO stamp with its offset, which is the only
 * form calendarView reads the way a person means it. The second lookup
 * catches a day whose midnight sits on the far side of a DST change from the
 * UTC guess.
 */
export function localMidnight(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y!, m! - 1, d!)
  let off = offsetMinutes(new Date(guess), timeZone)
  const settled = offsetMinutes(new Date(guess - off * 60_000), timeZone)
  if (settled !== off) off = settled
  return `${day}T00:00:00${formatOffset(off)}`
}

/**
 * A Graph UTC stamp as local wall clock, YYYY-MM-DDTHH:MM:SS. Accepts both
 * shapes Graph uses: "2026-09-16T13:00:00Z" on messages and
 * "2026-09-16T13:00:00.0000000" (zone given separately) on events.
 */
export function utcToLocal(stamp: string, timeZone: string): string {
  if (!stamp) return ''
  const bare = stamp.replace(/\.\d+/, '').replace(/Z$/, '')
  const instant = new Date(`${bare}Z`)
  if (Number.isNaN(instant.getTime())) return stamp
  const p = parts(instant, timeZone)
  return `${p['year']}-${p['month']}-${p['day']}T${p['hour']}:${p['minute']}:${p['second']}`
}
