/**
 * tests/restart-notice.test.ts
 *
 * A restart is a hole, and on a webhook platform the hole eats messages.
 *
 * From havn-test's edge log, updating 1.19.2 to 1.20.0:
 *
 *   16:25:31  200  /api/teams/messages   (/update apply, confirmed)
 *   16:26:47  502  /api/teams/messages   "Hello"
 *   16:26:48  502  /api/teams/messages   "Hello"
 *   16:27:20  200  /api/teams/messages
 *
 * The process exited at 16:25:46 and systemd brought it back at 16:26:56. The
 * two hellos landed nine seconds short, got a 502 from an edge with nothing
 * behind it, and were never delivered again: no turn ran, no reply existed, and
 * every client correctly showed nothing. Teams pushes each message once, so a
 * 502 is not a delay, it is a loss. Telegram survives the same gap because it
 * polls and Telegram holds the backlog.
 *
 * The message that shipped with the self-restart made it worse by inviting
 * exactly the thing that gets lost: "Restarting now. Give me a minute, then say
 * hello." So: ask them to wait, speak first on the way back, and make the gap
 * small enough that the edge can hold a request across it.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyfile } from '../src/deploy/teams-edge.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A fresh module instance, so the notice helpers see only injected state. */
async function restartModule() {
  vi.resetModules()
  return await import('../src/infra/restart.js')
}

/** An in-memory app_state. */
function store(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    get: (k: string) => data[k] ?? null,
    set: (k: string, v: string) => {
      data[k] = v
    },
    data,
  }
}

describe('the restart notice', () => {
  it('survives from the command that restarts to the boot that follows', async () => {
    const m = await restartModule()
    const s = store()
    m.rememberRestartNotice({ chatId: 'chat-1', toVersion: '1.20.1' }, s.set)
    expect(m.pendingRestartNotice(s.get)).toEqual({ chatId: 'chat-1', toVersion: '1.20.1' })
  })

  it('is nothing on an ordinary boot', async () => {
    const m = await restartModule()
    expect(m.pendingRestartNotice(store().get)).toBeNull()
  })

  it('survives reading, so a crash before the send does not swallow it', async () => {
    // The only message telling the client the box is alive again should not be
    // consumed by merely looking at it.
    const m = await restartModule()
    const s = store()
    m.rememberRestartNotice({ chatId: 'chat-1', toVersion: '1.20.1' }, s.set)
    expect(m.pendingRestartNotice(s.get)).not.toBeNull()
    expect(m.pendingRestartNotice(s.get)).not.toBeNull()
  })

  it('is gone once cleared', async () => {
    const m = await restartModule()
    const s = store()
    m.rememberRestartNotice({ chatId: 'chat-1', toVersion: '1.20.1' }, s.set)
    m.clearRestartNotice(s.set)
    expect(m.pendingRestartNotice(s.get)).toBeNull()
  })

  it('ignores junk rather than throwing on the way up', async () => {
    const m = await restartModule()
    expect(m.pendingRestartNotice(store({ restart_notice: 'not json' }).get)).toBeNull()
    expect(m.pendingRestartNotice(store({ restart_notice: '{"toVersion":"1.2.3"}' }).get)).toBeNull()
  })

  it('says the version it came back on', async () => {
    const m = await restartModule()
    expect(m.restartNoticeMessage({ chatId: 'c', toVersion: '1.20.1' })).toContain('1.20.1')
    expect(m.restartNoticeMessage({ chatId: 'c', toVersion: '' })).toBe('Back. Go ahead.')
  })
})

describe('/update apply', () => {
  const bot = readFileSync(join(REPO, 'src', 'bot.ts'), 'utf-8')
  const apply = bot.slice(bot.indexOf('const result = await applyUpdate()'))
  const block = apply.slice(0, apply.indexOf('await adapter.sendMessage(chatId, result.message)'))

  it('records the notice before it asks to be restarted', () => {
    const remember = block.indexOf('rememberRestartNotice(')
    const request = block.indexOf('requestRestart()')
    expect(remember).toBeGreaterThan(-1)
    expect(request).toBeGreaterThan(remember)
  })

  it('tells the client to wait instead of inviting a message into the gap', () => {
    expect(block).not.toContain('then say hello')
    expect(block).toMatch(/will not reach me/i)
  })
})

describe('boot', () => {
  const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')

  it('announces the restart before anything else it might say', () => {
    // The client is holding a message. That comes before the onboarding offer.
    const notice = index.indexOf('pendingRestartNotice()')
    const offer = index.indexOf('shouldOfferInterview(PROJECT_ROOT)')
    expect(notice).toBeGreaterThan(-1)
    expect(offer).toBeGreaterThan(notice)
  })

  it('clears the notice whether or not the send worked', () => {
    // A notice that outlived a failed send would be announced on every boot.
    const block = index.slice(index.indexOf('pendingRestartNotice()'))
    const clear = block.indexOf('clearRestartNotice()')
    const finallyAt = block.indexOf('} finally {')
    expect(clear).toBeGreaterThan(finallyAt)
    expect(finallyAt).toBeGreaterThan(-1)
  })
})

describe('the edge holds a webhook across a restart', () => {
  it('retries instead of answering 502 while the app is down', () => {
    const caddy = buildCaddyfile('havn.example.com', { teams: true })
    expect(caddy).toContain('lb_try_duration 15s')
    expect(caddy).toContain('lb_try_interval 500ms')
  })

  it('waits no longer than the Bot Framework does', () => {
    // Holding past the caller's patience does not save the message, it just
    // fails more slowly, so the number is a real bound rather than a guess.
    const caddy = buildCaddyfile('havn.example.com', { teams: true })
    const secs = Number(/lb_try_duration (\d+)s/.exec(caddy)?.[1])
    expect(secs).toBeGreaterThan(0)
    expect(secs).toBeLessThanOrEqual(15)
  })

  it('adds nothing when there is no Teams webhook to hold', () => {
    expect(buildCaddyfile('havn.example.com', { teams: false })).not.toContain('lb_try_duration')
  })
})

describe('enable-teams', () => {
  const script = readFileSync(join(REPO, 'scripts', 'hosted', 'enable-teams.ts'), 'utf-8')

  it('drops the restart delay a webhook box does not need', () => {
    // 70s in the shared unit exists so a new Telegram poller does not start
    // inside Telegram's getUpdates conflict window. A Teams box has no poller,
    // and every one of those seconds is a message it cannot receive.
    expect(script).toContain('RestartSec=5')
    expect(script).toContain('/etc/systemd/system/havn.service.d')
    expect(script).toContain("run('systemctl', ['daemon-reload'])")
  })
})
