/** Web routes for projects and goals. */
import { registerWebRoutes } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { listProjects } from './projects.js'
import { readGoals, addGoal, updateGoal, setGoalDone, deleteGoal, GoalConflict, GoalInvalid } from './goals.js'

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/projects$/,
    auth: true,
    handler(ctx) {
      const general = { id: '', name: 'General', company: '', status: '', statePath: '' }
      sendJson(ctx.res, 200, [general, ...listProjects()])
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
