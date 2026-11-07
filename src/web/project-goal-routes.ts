/** Web routes for projects and goals. */
import { registerWebRoutes, type WebRoute } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { listProjects } from './projects.js'
import { createProject, getProject, listChatProjects, renameProject, setInstructions } from '../projects/store.js'
import { readGoals, addGoal, updateGoal, setGoalDone, deleteGoal, GoalConflict, GoalInvalid } from './goals.js'

/** The JSON body, or null once the error has been sent. */
async function body(ctx: Parameters<WebRoute['handler']>[0]): Promise<Record<string, unknown> | null> {
  try {
    return (await readJsonCapped(ctx.req)) as Record<string, unknown>
  } catch (err) {
    if (err instanceof BodyError) {
      sendError(ctx.res, err.status, err.code)
      return null
    }
    throw err
  }
}

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/projects$/,
    auth: true,
    handler(ctx) {
      const general = { id: '', name: 'General', company: '', status: '', statePath: '' }
      const own = listChatProjects(ctx.chatId).map((p) => ({ ...general, id: p.id, name: p.name, own: true, instructions: p.instructions }))
      sendJson(ctx.res, 200, [general, ...own, ...listProjects()])
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects$/,
    auth: true,
    async handler(ctx) {
      const b = await body(ctx)
      if (!b) return
      const r = createProject(ctx.chatId, typeof b.name === 'string' ? b.name : '')
      if ('error' in r) return sendError(ctx.res, 400, `name_${r.error}`)
      sendJson(ctx.res, 200, { project: r.project })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/(?!import$)([^/]+)$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getProject(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      const b = await body(ctx)
      if (!b) return
      if (typeof b.name === 'string') {
        const r = renameProject(ctx.chatId, id, b.name)
        if (r && 'error' in r) return sendError(ctx.res, 400, `name_${r.error}`)
      }
      if (typeof b.instructions === 'string' && setInstructions(ctx.chatId, id, b.instructions) === 'too_long') {
        return sendError(ctx.res, 400, 'instructions_too_long')
      }
      sendJson(ctx.res, 200, { project: getProject(ctx.chatId, id) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/([^/]+)\/delete$/,
    auth: true,
    async handler(ctx) {
      // Loaded here: bot.ts pulls in the web routes, so a top-level import is a cycle.
      const { removeProject } = await import('../bot.js')
      if (!removeProject(ctx.chatId, ctx.params[0]!)) return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/goals$/,
    auth: true,
    handler(ctx) {
      sendJson(ctx.res, 200, readGoals())
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/goals$/,
    auth: true,
    async handler(ctx) {
      let b: Record<string, unknown>
      try {
        const parsed = await readJsonCapped(ctx.req)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendError(ctx.res, 400, 'bad_json')
        b = parsed as Record<string, unknown>
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      const version = typeof b['version'] === 'string' ? b['version'] : ''
      const index = b['index'] as number
      try {
        let result
        switch (b['action']) {
          case 'add':
            result = addGoal(b['text'] as string, version)
            break
          case 'update':
            result = updateGoal(index, b['text'] as string, version)
            break
          case 'done':
            result = setGoalDone(index, b['done'] as boolean, version)
            break
          case 'delete':
            result = deleteGoal(index, version)
            break
          default:
            return sendError(ctx.res, 400, 'bad_action')
        }
        sendJson(ctx.res, 200, result)
      } catch (err) {
        if (err instanceof GoalConflict) return sendJson(ctx.res, 409, { error: 'goals_changed', ...readGoals() })
        if (err instanceof GoalInvalid) return sendError(ctx.res, 400, err.message)
        throw err
      }
    },
  },
])
