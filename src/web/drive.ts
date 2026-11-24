/**
 * Card #284: read-only Google Drive access for the web files panel, through the
 * gog CLI (github.com/openclaw/gogcli). Three reads only: list a folder, get one
 * file's metadata, download (or export) one file. Every call is `--readonly` and
 * limited with `--enable-commands-exact` to the one subcommand it needs, so no
 * code path here can reach a mutating `gog drive` command.
 *
 * Tokens: a relay-connected account's access token goes to gog in
 * GOG_ACCESS_TOKEN, never on the command line, never in process.env, never in a
 * log. The REAL gog binary is called, not the account-picking wrapper, because
 * the wrapper's job is Gmail. Logs carry event names and counts only.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { STORE_DIR } from '../config.js'
import { realGogBin, resolveGogBin } from '../infra/gog-bin.js'
import { connectSettings, getDriveKeeper } from '../connect/instance.js'
import type { DriveTokenKeeper } from '../connect/drive-token.js'
import { cachedCheck } from './connections.js'
import { parseGogAccounts } from '../email-alerts/sources.js'
import { dispositionName, GOOGLE_EXPORT_PDF } from './file-kind.js'

export { GOOGLE_EXPORT_PDF }

export type DriveError = 'not_connected' | 'reconnect' | 'not_found' | 'too_large' | 'unavailable'

export class DriveFailure extends Error {
  constructor(public readonly code: DriveError) {
    super(code)
    this.name = 'DriveFailure'
  }
}

export interface DriveEntry {
  id: string
  name: string
  isDir: boolean
  mimeType: string
  size?: number
  modified?: string
}

export interface DriveDeps {
  /** `env` holds only what to add (the token); the default merges it over a clean copy of process.env. */
  run(args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number; stdout: string }>
  keeper: Pick<DriveTokenKeeper, 'accounts' | 'token'> | null
  relayConfigured: boolean
  /** True when the real gog binary resolves to an existing file. */
  gogInstalled(): boolean
  /** The stdout of `gog auth list --plain` (AUTH_LIST_ARGS). */
  gogAuthList(): Promise<string>
  tmpDir: string
  now(): number
}

export const MAX_DRIVE_BYTES = 25 * 1024 * 1024
/** Never starts with '-', so an id can not be read as a gog flag. */
export const DRIVE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/
/**
 * Drive page tokens are opaque and may hold any punctuation (some begin `~!!~`).
 * The token goes to gog as one `--page=<token>` argument through execFile, so
 * no shell reads it: only the length, whitespace, control characters and a
 * leading dash are checked.
 */
const PAGE_TOKEN = /^(?!-)[^\s\p{Cc}]{1,2048}$/u
export const PAGE_SIZE = 100
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const GOOGLE_NATIVE = 'application/vnd.google-apps.'

const CALL_TIMEOUT_MS = 30_000
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_IN_FLIGHT = 2
const TMP_MAX_AGE_MS = 10 * 60_000
const ACCOUNTS_CACHE_MS = 5 * 60_000
const FIELDS = 'id,name,mimeType,size,modifiedTime,trashed'

// ---------- Running gog ----------

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['GOG_ACCESS_TOKEN']
  delete env['GOG_RELAY_TOKENS']
  return { ...env, ...extra }
}

function defaultRun(args: string[], extra: Record<string, string>, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  const bin = realGogBin() ?? resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: cleanEnv(extra) }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) })
      const code = (err as { code?: unknown }).code
      // A non-zero exit carries a numeric code; a spawn failure or timeout is a real error.
      if (typeof code === 'number' && !(err as { killed?: boolean }).killed) return resolve({ code, stdout: String(stdout) })
      reject(err)
    })
  })
}

export const AUTH_LIST_ARGS = ['auth', 'list', '--plain', '--readonly', '--enable-commands-exact', 'auth.list']

/**
 * `gog auth list` kept for a while, but only while it names an account with
 * Drive: an answer without one is asked again next time, so a sign-in just
 * finished shows at once.
 */
export function driveAuthListCache(
  read: () => Promise<string>,
  ttlMs: number = ACCOUNTS_CACHE_MS,
  now: () => number = Date.now,
): { get(): Promise<string>; reset(): void } {
  const check = cachedCheck(read, ttlMs, now)
  return {
    async get() {
      const out = await check.get()
      if (parseGogAccounts(out, 'drive').length === 0) check.reset()
      return out
    },
    reset: () => check.reset(),
  }
}

const gogAuthListCheck = driveAuthListCache(() => {
  const bin = realGogBin() ?? resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
  return new Promise<string>((resolve, reject) => {
    execFile(bin, AUTH_LIST_ARGS, { timeout: 5_000, maxBuffer: 1024 * 1024, env: cleanEnv({}) }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
})

/** Forget the cached gog account list (the connect route calls this on a gog box). */
export function resetDriveAccounts(): void {
  gogAuthListCheck.reset()
}

function defaultGogInstalled(): boolean {
  const bin = realGogBin() ?? resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
  // resolveGogBin falls back to the bare command name when nothing exists on disk.
  return isAbsolute(bin) && existsSync(bin)
}

function defaultDeps(): DriveDeps {
  return {
    run: defaultRun,
    keeper: getDriveKeeper(),
    relayConfigured: connectSettings() !== null,
    gogInstalled: defaultGogInstalled,
    gogAuthList: () => gogAuthListCheck.get(),
    tmpDir: join(STORE_DIR, 'drive-tmp'),
    now: () => Date.now(),
  }
}

// At most two gog calls at once per box, FIFO, released on every outcome.
let active = 0
const waiting: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r))
  else active++
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next() // hand the place straight over
    else active--
  }
}

// ---------- Accounts ----------

export async function driveAccounts(deps: DriveDeps = defaultDeps()): Promise<{ account: string; state: 'ok' | 'reconnect' }[]> {
  if (deps.relayConfigured) return deps.keeper ? deps.keeper.accounts() : []
  if (!deps.gogInstalled()) return []
  try {
    return parseGogAccounts(await deps.gogAuthList(), 'drive').map((account) => ({ account, state: 'ok' as const }))
  } catch {
    return []
  }
}

/** Where Drive sign-ins come from on this box: the relay, or gog's own stored accounts. */
export function driveConnectMode(deps: DriveDeps = defaultDeps()): 'relay' | 'gog' | null {
  if (deps.relayConfigured) return 'relay'
  return deps.gogInstalled() ? 'gog' : null
}

/** Who may be read, and how gog is told: a token for a relay account, --account otherwise. */
async function authFor(account: string, deps: DriveDeps): Promise<{ env: Record<string, string>; args: string[] }> {
  const known = (await driveAccounts(deps)).find((a) => a.account.toLowerCase() === account.toLowerCase())
  if (!known) throw new DriveFailure('not_connected')
  if (known.state === 'reconnect') throw new DriveFailure('reconnect')
  if (!deps.relayConfigured) return { env: {}, args: ['--account', known.account] }
  const token = deps.keeper ? await deps.keeper.token(known.account) : null
  // Not revoked but no token (renewal failed, relay down): a passing problem, not a new sign-in.
  if (!token) throw new DriveFailure('unavailable')
  return { env: { GOG_ACCESS_TOKEN: token }, args: [] }
}

// ---------- Calls ----------

/** Stdout for a good run, or null for exit 3 (gog: empty results) on `ls`, which is an empty folder. */
async function gog(command: 'ls' | 'get' | 'download', flags: string[], positional: string | null, account: string, deps: DriveDeps): Promise<string | null> {
  const auth = await authFor(account, deps)
  // Flags first, then `--` and the id, so an id can never be taken for a flag.
  const full = ['drive', command, '--json', ...flags, '--readonly', '--enable-commands-exact', `drive.${command}`, ...auth.args, ...(positional ? ['--', positional] : [])]
  // Count only: the exit, never stderr, ids, names or accounts.
  const failed = (exit: number | string) => logger.warn({ event: `drive ${command}`, ok: false, exit }, 'drive call failed')
  let r: { code: number; stdout: string }
  try {
    r = await limited(() => deps.run(full, auth.env, CALL_TIMEOUT_MS))
  } catch (err) {
    const e = err as { killed?: boolean; code?: unknown }
    failed(e.code === 'ENOENT' ? 'missing' : e.killed ? 'timeout' : 'error')
    throw new DriveFailure('unavailable')
  }
  if (r.code === 0) return r.stdout
  if (r.code === 3 && command === 'ls') return null
  failed(r.code)
  // gog documents exit code 5 as "not found" and 4 as "auth" (the sign-in has
  // expired or been withdrawn); every other failure is unavailable.
  if (r.code === 5) throw new DriveFailure('not_found')
  if (r.code === 4) throw new DriveFailure('reconnect')
  throw new DriveFailure('unavailable')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new DriveFailure('unavailable')
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One Drive file row, tolerant of field spelling and of size as text. Null for a row we cannot use. */
function toEntry(row: unknown): DriveEntry | null {
  if (!isObj(row) || row['trashed'] === true) return null
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  if (!id) return null
  const mimeType = typeof row['mimeType'] === 'string' ? row['mimeType'] : ''
  const entry: DriveEntry = { id, name: typeof row['name'] === 'string' ? row['name'] : id, isDir: mimeType === FOLDER_MIME, mimeType }
  const size = Number(row['size'])
  if (row['size'] !== undefined && row['size'] !== null && row['size'] !== '' && Number.isFinite(size)) entry.size = size
  const modified = row['modifiedTime'] ?? row['modified']
  if (typeof modified === 'string') entry.modified = modified
  return entry
}

const byFoldersThenName = (a: DriveEntry, b: DriveEntry): number =>
  a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase())

export async function listFolder(
  account: string,
  folderId: string,
  pageToken?: string,
  deps: DriveDeps = defaultDeps(),
): Promise<{ entries: DriveEntry[]; nextPage: string | null }> {
  if (!DRIVE_ID.test(folderId)) throw new DriveFailure('not_found')
  if (pageToken !== undefined && !PAGE_TOKEN.test(pageToken)) throw new DriveFailure('not_found')
  const args = [
    `--parent=${folderId}`, '--max', String(PAGE_SIZE), '--no-all-drives',
    '--fields', `files(${FIELDS}),nextPageToken`,
    ...(pageToken !== undefined ? [`--page=${pageToken}`] : []),
  ]
  const out = await gog('ls', args, null, account, deps)
  if (out === null) {
    logger.info({ event: 'drive list', entries: 0, ok: true })
    return { entries: [], nextPage: null }
  }
  const data = parseJson(out)
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data['files']) ? data['files'] : []
  const entries = rows.map(toEntry).filter((e): e is DriveEntry => e !== null).sort(byFoldersThenName)
  const next = isObj(data) && typeof data['nextPageToken'] === 'string' && data['nextPageToken'] ? data['nextPageToken'] : null
  logger.info({ event: 'drive list', entries: entries.length, ok: true })
  return { entries, nextPage: next }
}

export async function getFile(account: string, fileId: string, deps: DriveDeps = defaultDeps()): Promise<DriveEntry> {
  if (!DRIVE_ID.test(fileId)) throw new DriveFailure('not_found')
  const data = parseJson((await gog('get', ['--fields', FIELDS], fileId, account, deps)) ?? '')
  const entry = toEntry(isObj(data) && isObj(data['file']) ? data['file'] : data)
  if (!entry) throw new DriveFailure('not_found')
  return entry
}

function sweep(dir: string, now: number): void {
  try {
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f)
        if (now - statSync(p).mtimeMs > TMP_MAX_AGE_MS) unlinkSync(p)
      } catch { /* gone already */ }
    }
  } catch { /* no directory yet */ }
}

function remove(path: string): void {
  try {
    unlinkSync(path)
  } catch { /* already gone */ }
}

export async function fetchFile(
  account: string,
  fileId: string,
  deps: DriveDeps = defaultDeps(),
): Promise<{ path: string; name: string; mimeType: string; cleanup(): void }> {
  if (!DRIVE_ID.test(fileId)) throw new DriveFailure('not_found')
  mkdirSync(deps.tmpDir, { recursive: true })
  sweep(deps.tmpDir, deps.now())
  const meta = await getFile(account, fileId, deps)
  const exported = GOOGLE_EXPORT_PDF.has(meta.mimeType)
  // Folders and Forms, Sites, shortcuts have no file to hand over.
  if (meta.isDir || (!exported && meta.mimeType.startsWith(GOOGLE_NATIVE))) throw new DriveFailure('not_found')
  if (!exported && meta.size !== undefined && meta.size > MAX_DRIVE_BYTES) throw new DriveFailure('too_large')

  const path = join(deps.tmpDir, randomBytes(12).toString('hex'))
  try {
    // --json is passed for uniformity; stdout is ignored, the file at --out is the result.
    await gog('download', [...(exported ? ['--format', 'pdf'] : []), '--out', path], fileId, account, deps)
    if (!existsSync(path)) throw new DriveFailure('unavailable')
    if (statSync(path).size > MAX_DRIVE_BYTES) throw new DriveFailure('too_large')
  } catch (err) {
    remove(path)
    throw err
  }
  logger.info({ event: 'drive fetch', ok: true })
  return {
    path,
    name: exported ? `${dispositionName(meta.name)}.pdf` : dispositionName(meta.name),
    mimeType: exported ? 'application/pdf' : meta.mimeType || 'application/octet-stream',
    cleanup: () => remove(path),
  }
}
