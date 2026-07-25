/**
 * Pure logic for the zero-cost Gmail cleanup sweep.
 *
 * CRITICAL: gog gmail search is THREAD-scoped. A query like
 * "older_than:5y -is:starred" matches whole threads, and the message ID a row
 * carries can be a starred, already-trashed, or too-recent message whose
 * *sibling* matched. Query-level guards are therefore not sufficient — every
 * row is re-checked against its own LABELS and DATE columns here. Never trust
 * query-level guards alone.
 */

/** One data row from `gog gmail search --plain` (TSV: ID DATE FROM SUBJECT LABELS THREAD). */
export interface SearchRow {
  id: string
  date: string
  labels: string
}

export interface SearchPage {
  rows: SearchRow[]
  nextPageToken: string | null
}

const MESSAGE_ID = /^[0-9a-f]{16}$/
const NEXT_PAGE_PREFIX = '# Next page: --page '

export function parseSearchPage(raw: string): SearchPage {
  const rows: SearchRow[] = []
  let nextPageToken: string | null = null

  for (const line of raw.split('\n')) {
    if (line.startsWith(NEXT_PAGE_PREFIX)) {
      nextPageToken = line.slice(NEXT_PAGE_PREFIX.length).trim() || null
      continue
    }
    const cols = line.split('\t')
    if (cols.length < 5 || !MESSAGE_ID.test(cols[0])) continue
    rows.push({ id: cols[0], date: cols[1], labels: cols[4] })
  }

  return { rows, nextPageToken }
}

export interface FilterOptions {
  /** Local YYYY-MM-DD; only rows strictly older pass (DATE is ISO, string compare is safe). */
  cutoff: string
  /** Label that must be present on the row itself (e.g. CATEGORY_PROMOTIONS). */
  requiredLabel?: string
  /** IDs already trashed this run — Gmail's search index lags behind modify calls. */
  exclude: Set<string>
}

export function filterRows(rows: SearchRow[], opts: FilterOptions): string[] {
  return rows
    .filter(
      (r) =>
        !r.labels.includes('STARRED') &&
        !r.labels.includes('TRASH') &&
        r.date < opts.cutoff &&
        (!opts.requiredLabel || r.labels.includes(opts.requiredLabel)) &&
        !opts.exclude.has(r.id)
    )
    .map((r) => r.id)
}

function ymdLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Local date minus months/years as YYYY-MM-DD, clamping to the last day of the
 * target month (matches BSD `date -v-3m`: May 31 - 3m = Feb 28, not Mar 3).
 */
export function cutoffDate(now: Date, delta: { months?: number; years?: number }): string {
  const targetYear = now.getFullYear() - (delta.years ?? 0)
  const targetMonth = now.getMonth() - (delta.months ?? 0)
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate()
  return ymdLocal(new Date(targetYear, targetMonth, Math.min(now.getDate(), lastDay)))
}

/** Cron expression firing once at now + offsetMinutes (local time, no leading zeros). */
export function oneShotCron(now: Date, offsetMinutes = 2): string {
  const at = new Date(now.getTime() + offsetMinutes * 60_000)
  return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`
}

export interface SweepTotals {
  promoTrashed: number
  ancientTrashed: number
  skipped: number
  errors: string[]
}

/** Report prompt for the one-shot dispatch, or null when there is nothing to say (clean run). */
export function buildReport(totals: SweepTotals): string | null {
  const { promoTrashed, ancientTrashed, skipped, errors } = totals
  if (promoTrashed === 0 && ancientTrashed === 0 && errors.length === 0) return null

  const summary =
    `Trashed ${promoTrashed} promo, ${ancientTrashed} ancient (5y+). ` +
    `Starred kept (${skipped} protected row(s) skipped). Gmail purges trash after 30 days.`

  let report = `Gmail cleanup report:\n\n${summary}`
  if (errors.length > 0) report += `\n\nError: ${errors.join('\n')}`
  return report
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
