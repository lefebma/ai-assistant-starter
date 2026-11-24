/**
 * Web routes for file sources other than the local folder. Today that is
 * Google Drive, read only, and only for the main chat: any other signed-in
 * chat gets the same 404 as a route that does not exist. Logs carry counts
 * only (drive.ts logs them); no id, name or account is written here.
 */
import { createReadStream, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream'
import { logger } from '../logger.js'
import { registerWebRoutes, type WebRoute } from './http.js'
import { sendJson, sendError } from './respond.js'
import { isMainChat } from './file-access.js'
import { kindFromMime, rawHeaders, type FileKind } from './file-kind.js'
import { DriveFailure, driveAccounts, driveConnectMode, fetchFile, listFolder, resetDriveAccounts, type DriveDeps, type DriveError } from './drive.js'
import { getConnectFlow } from '../connect/instance.js'

const STATUS: Record<DriveError, number> = { not_connected: 409, reconnect: 409, not_found: 404, too_large: 413, unavailable: 503 }

/** The gog command a box without the relay shows for connecting Drive. */
const GOG_CONNECT_COMMAND =
  'gog auth add <your Gmail address> --services gmail,calendar,drive --drive-scope readonly --gmail-scope send --extra-scopes https://www.googleapis.com/auth/gmail.modify'

let testDeps: DriveDeps | undefined

/** Test hook: the Drive dependencies every route uses. Pass null to restore the real ones. */
export function setDriveDepsForTests(deps: DriveDeps | null): void {
  testDeps = deps ?? undefined
}

function fail(res: ServerResponse, err: unknown): void {
  const code: DriveError = err instanceof DriveFailure ? err.code : 'unavailable'
  sendError(res, STATUS[code], code)
}

type Ctx = Parameters<WebRoute['handler']>[0]

interface Source {
  prefix: string
  list(ctx: Ctx): Promise<void>
  raw(ctx: Ctx): Promise<void>
}

const drive: Source = {
  prefix: 'drive',
  async list(ctx) {
    try {
      const q = ctx.url.searchParams
      const page = q.get('page')
      const { entries, nextPage } = await listFolder(q.get('account') ?? '', q.get('folder') || 'root', page || undefined, testDeps)
      const withKind = entries.map((e) => ({ ...e, kind: (e.isDir ? 'other' : kindFromMime(e.mimeType).kind) as FileKind }))
      sendJson(ctx.res, 200, { entries: withKind, nextPage })
    } catch (err) {
      fail(ctx.res, err)
    }
  },
  async raw(ctx) {
    const { res } = ctx
    let file: Awaited<ReturnType<typeof fetchFile>>
    try {
      file = await fetchFile(ctx.url.searchParams.get('account') ?? '', ctx.url.searchParams.get('id') ?? '', testDeps)
    } catch (err) {
      return fail(res, err)
    }
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      file.cleanup()
    }
    res.on('finish', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
    let size: number
    try {
      size = statSync(file.path).size
    } catch {
      cleanup()
      return sendError(res, 503, 'unavailable')
    }
    const { kind, mime } = kindFromMime(file.mimeType)
    res.writeHead(200, rawHeaders(kind, mime, file.name, size))
    // pipeline destroys the file stream when the browser hangs up, so no descriptor outlives the download.
    pipeline(createReadStream(file.path), res, () => cleanup())
  },
}

const SOURCES: Source[] = [drive]

const OWNER_ONLY = (ctx: Ctx): boolean => isMainChat(ctx.chatId)

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/sources$/,
    auth: true,
    async handler(ctx) {
      const sources: unknown[] = [{ id: 'local', name: 'Havn files' }]
      if (!OWNER_ONLY(ctx)) return sendJson(ctx.res, 200, { sources, canConnectDrive: false, connect: null })
      const connect = driveConnectMode(testDeps)
      let accounts: Awaited<ReturnType<typeof driveAccounts>> = []
      try {
        accounts = await driveAccounts(testDeps)
      } catch {
        // A failing check shows no Drive rather than breaking the panel. Count only: no account or error text.
        logger.warn({ event: 'drive sources failed' }, 'drive accounts check failed')
      }
      for (const a of accounts) sources.push({ id: `drive:${a.account}`, name: 'Google Drive', account: a.account, state: a.state })
      sendJson(ctx.res, 200, { sources, canConnectDrive: connect !== null, connect })
    },
  },
  ...SOURCES.flatMap((s): WebRoute[] => [
    {
      method: 'GET',
      pattern: new RegExp(`^/api/web/sources/${s.prefix}/list$`),
      auth: true,
      handler: (ctx) => (OWNER_ONLY(ctx) ? s.list(ctx) : sendError(ctx.res, 404, 'not_found')),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/web/sources/${s.prefix}/raw$`),
      auth: true,
      handler: (ctx) => (OWNER_ONLY(ctx) ? s.raw(ctx) : sendError(ctx.res, 404, 'not_found')),
    },
  ]),
  {
    method: 'POST',
    pattern: /^\/api\/web\/sources\/drive\/connect$/,
    auth: true,
    handler(ctx) {
      const mode = OWNER_ONLY(ctx) ? driveConnectMode(testDeps) : null
      if (!mode) return sendError(ctx.res, 404, 'not_found')
      if (mode === 'gog') {
        // The next sources check asks gog again, so Refresh after the sign-in shows Drive.
        resetDriveAccounts()
        return sendJson(ctx.res, 200, { command: GOG_CONNECT_COMMAND })
      }
      const flow = getConnectFlow()
      if (!flow) return sendError(ctx.res, 503, 'unavailable')
      sendJson(ctx.res, 200, { url: flow.startLink(ctx.chatId, 'drive') })
    },
  },
])
