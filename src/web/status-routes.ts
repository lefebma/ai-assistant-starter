/** Web routes: connections, and the update notice. */
import { registerWebRoutes } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { getConnections, checkConnectionsNow, connectionDeps } from './connections.js'
import { checkForUpdate, restartPending, getCurrentVersion } from '../updater.js'
import { getAppState, setAppState } from '../db.js'

export const DISMISS_KEY = 'web.update.dismissed'

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/connections$/,
    auth: true,
    async handler(ctx) {
      sendJson(ctx.res, 200, await getConnections({ ...connectionDeps(), chatId: () => ctx.chatId }))
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/connections\/check$/,
    auth: true,
    async handler(ctx) {
      sendJson(ctx.res, 200, await checkConnectionsNow({ ...connectionDeps(), chatId: () => ctx.chatId }))
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/status$/,
    auth: true,
    async handler(ctx) {
      let version = ''
      try {
        version = getCurrentVersion()
      } catch {
        // fall through with an empty version
      }
      let latestVersion: string | null = null
      let updateAvailable = false
      try {
        const s = await checkForUpdate(true)
        version = s.currentVersion || version
        latestVersion = s.latestVersion
        updateAvailable = !!s.updateAvailable && !s.error
      } catch {
        updateAvailable = false
      }
      let pending = false
      try {
        pending = restartPending()
      } catch {
        pending = false
      }
      const dismissed = updateAvailable && latestVersion !== null && getAppState(DISMISS_KEY) === latestVersion
      sendJson(ctx.res, 200, { version, latestVersion, updateAvailable, restartPending: pending, dismissed })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/status\/dismiss$/,
    auth: true,
    async handler(ctx) {
      let version = ''
      try {
        const b = (await readJsonCapped(ctx.req)) as Record<string, unknown> | null
        version = b && typeof b['version'] === 'string' ? b['version'].trim() : ''
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      if (!version || version.length > 40) return sendError(ctx.res, 400, 'bad_version')
      setAppState(DISMISS_KEY, version)
      sendJson(ctx.res, 200, { ok: true })
    },
  },
])
