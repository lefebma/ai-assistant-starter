/** Card #280: the generic POST /projects/:id route must never claim /projects/import, whatever order modules load in. */
import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-web-route-order-${process.pid}`
})

const captured: { method: string; pattern: RegExp }[] = []
vi.mock('../src/web/http.js', async (orig) => ({
  ...(await orig<typeof import('../src/web/http.js')>()),
  registerWebRoutes: (add: { method: string; pattern: RegExp }[]) => {
    captured.push(...add)
    return () => {}
  },
}))

describe('route order', () => {
  it('no project-goal route matches the import upload path', async () => {
    await import('../src/web/project-goal-routes.js')
    const hits = captured.filter((r) => r.method === 'POST' && r.pattern.test('/api/web/projects/import'))
    expect(hits).toEqual([])
    expect(captured.some((r) => r.pattern.test('/api/web/projects/abc'))).toBe(true)
  })
})
