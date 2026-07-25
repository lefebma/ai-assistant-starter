import { parseSearchPage, filterRows, chunk } from './core.js'

export interface SweepStep {
  query: string
  /** Local YYYY-MM-DD; rows must be strictly older to be trashed. */
  cutoff: string
  requiredLabel?: string
}

/** The gog boundary, injected so tests (and dry runs) never touch a real mailbox. */
export interface SweepIO {
  search(query: string, pageToken?: string): Promise<{ ok: boolean; output: string }>
  /** Move one chunk of message ids to Trash. Returns false on failure. */
  trash(ids: string[]): Promise<boolean>
  sleep?(ms: number): Promise<void>
}

export interface SweepOptions {
  perPage?: number
  maxIter?: number
  chunkSize?: number
  /** Count the first page only; no trash calls. */
  dryRun?: boolean
}

export interface SweepResult {
  trashed: number
  skipped: number
  errors: string[]
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * One paginated trash pass over a query. Every page is re-filtered per row
 * (thread-scoped search — see core.ts) and already-trashed ids are excluded
 * (Gmail's search index lags behind modify calls, so they reappear).
 */
export async function runSweep(step: SweepStep, io: SweepIO, opts: SweepOptions = {}): Promise<SweepResult> {
  const perPage = opts.perPage ?? 100
  const maxIter = opts.maxIter ?? 30
  const chunkSize = opts.chunkSize ?? 25
  const sleep = io.sleep ?? defaultSleep

  const alreadyTrashed = new Set<string>()
  const result: SweepResult = { trashed: 0, skipped: 0, errors: [] }
  let pageToken: string | undefined

  for (let iter = 0; iter < maxIter; iter++) {
    const res = await io.search(step.query, pageToken)
    if (!res.ok) {
      result.errors.push(`search failed for [${step.query}]: ${res.output.slice(0, 300)}`)
      break
    }

    const page = parseSearchPage(res.output)
    pageToken = page.nextPageToken ?? undefined
    const rawCount = page.rows.length
    if (rawCount === 0) break

    const keep = filterRows(page.rows, {
      cutoff: step.cutoff,
      requiredLabel: step.requiredLabel,
      exclude: alreadyTrashed,
    })

    if (keep.length === 0) {
      // Everything on this page is protected or already trashed; ghost rows
      // from thread-scoped search dominate early pages, so keep paginating
      // while there is a next page.
      result.skipped += rawCount
      if (pageToken) {
        await sleep(1000)
        continue
      }
      break
    }

    result.skipped += rawCount - keep.length

    if (opts.dryRun) {
      result.trashed = keep.length // first-page count only
      break
    }

    let failed = false
    for (const ids of chunk(keep, chunkSize)) {
      if (!(await io.trash(ids))) {
        result.errors.push(`batch modify failed for [${step.query}] after ${result.trashed} trashed`)
        failed = true
        break
      }
      result.trashed += ids.length
      for (const id of ids) alreadyTrashed.add(id)
    }
    if (failed) break

    if (rawCount < perPage || !pageToken) break
    await sleep(1000)
  }

  return result
}
