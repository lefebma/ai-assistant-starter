import { describe, it, expect, vi } from 'vitest'
import { LaunchdManager } from '../src/service/launchd.js'
import { SystemdManager } from '../src/service/systemd.js'
import { resolveServiceManager } from '../src/service/index.js'
import type { ServiceIO } from '../src/service/types.js'

const OPTS = {
  label: 'com.ai-assistant.service',
  name: 'ai-assistant',
  nodePath: '/usr/bin/node',
  entry: '/repo/dist/src/index.js',
  cwd: '/repo',
  logFile: '/repo/logs/service.log',
}

function fakeIO(execResults: Record<string, { code?: number; out?: string }> = {}) {
  const writes: Array<{ path: string; content: string }> = []
  const removed: string[] = []
  const execCalls: string[] = []
  const dirs: string[] = []
  /** Ordered trace, so "created the dir before loading the job" is checkable. */
  const order: string[] = []
  const io: ServiceIO = {
    exec: vi.fn(async (cmd: string, args: string[]) => {
      const joined = `${cmd} ${args.join(' ')}`
      execCalls.push(joined)
      order.push(`exec:${joined}`)
      for (const [prefix, res] of Object.entries(execResults)) {
        if (joined.startsWith(prefix)) return { code: res.code ?? 0, out: res.out ?? '' }
      }
      return { code: 0, out: '' }
    }),
    writeFile: (path, content) => {
      writes.push({ path, content })
      order.push(`write:${path}`)
    },
    removeFile: (path) => void removed.push(path),
    exists: () => true,
    ensureDir: (path) => {
      dirs.push(path)
      order.push(`mkdir:${path}`)
    },
  }
  return { io, writes, removed, execCalls, dirs, order }
}

describe('LaunchdManager', () => {
  it('install writes the plist to LaunchAgents and loads it', async () => {
    const { io, writes, execCalls } = fakeIO()
    const m = new LaunchdManager(OPTS, io, '/Users/me')
    await m.install()
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('/Users/me/Library/LaunchAgents/com.ai-assistant.service.plist')
    expect(writes[0].content).toContain('com.ai-assistant.service')
    expect(execCalls.some((c) => c.startsWith('launchctl load'))).toBe(true)
  })

  it('uninstall unloads and removes the plist', async () => {
    const { io, removed, execCalls } = fakeIO()
    const m = new LaunchdManager(OPTS, io, '/Users/me')
    await m.uninstall()
    expect(execCalls.some((c) => c.startsWith('launchctl unload'))).toBe(true)
    expect(removed).toEqual(['/Users/me/Library/LaunchAgents/com.ai-assistant.service.plist'])
  })

  it('status reflects launchctl list', async () => {
    const { io } = fakeIO({ 'launchctl list': { code: 0, out: '"PID" = 99;' } })
    expect(await new LaunchdManager(OPTS, io, '/Users/me').status()).toBe('running')
  })
})

describe('SystemdManager', () => {
  it('install writes the user unit, reloads, and enables --now', async () => {
    const { io, writes, execCalls } = fakeIO()
    const m = new SystemdManager(OPTS, io, '/home/me')
    await m.install()
    expect(writes[0].path).toBe('/home/me/.config/systemd/user/ai-assistant.service')
    expect(execCalls.some((c) => c.startsWith('systemctl --user daemon-reload'))).toBe(true)
    expect(execCalls.some((c) => c.startsWith('systemctl --user enable --now ai-assistant'))).toBe(true)
  })
})

describe('resolveServiceManager', () => {
  it('picks the platform-appropriate manager', () => {
    expect(resolveServiceManager('darwin', OPTS).kind).toBe('launchd')
    expect(resolveServiceManager('linux', OPTS).kind).toBe('systemd')
    expect(resolveServiceManager('win32', OPTS).kind).toBe('schtasks')
  })
})

describe('log directory (regression: service loaded but never spawned)', () => {
  // A real install on a fresh Mac: `service install` wrote the plist pointing
  // StandardOutPath at <install>/logs/service.log, but nothing had created
  // logs/. launchd will not create it, so the job loaded and never spawned.
  // `launchctl list <label>` still exits 0, so status read "stopped", and
  // because the failure was in setting up stdio there was no log to explain
  // it. The owner saw a bot that answered nothing, with no diagnostic trail.
  // The restart launcher already did `mkdir -p logs`; install did not.
  it('launchd creates the log directory before loading the job', async () => {
    const { io, dirs, order } = fakeIO()
    await new LaunchdManager(OPTS, io, '/Users/me').install()

    expect(dirs).toContain('/repo/logs')
    const mkdir = order.indexOf('mkdir:/repo/logs')
    const load = order.findIndex((o) => o.startsWith('exec:launchctl load'))
    expect(mkdir).toBeGreaterThanOrEqual(0)
    expect(load).toBeGreaterThan(mkdir)
  })

  it('systemd creates it too (StandardOutput=append: fails the same way)', async () => {
    const { io, dirs, order } = fakeIO()
    await new SystemdManager(OPTS, io, '/home/me').install()

    expect(dirs).toContain('/repo/logs')
    const mkdir = order.indexOf('mkdir:/repo/logs')
    const enable = order.findIndex((o) => o.includes('enable'))
    expect(mkdir).toBeGreaterThanOrEqual(0)
    expect(enable).toBeGreaterThan(mkdir)
  })

  it('creates the directory holding the log, not the log path itself', async () => {
    const { io, dirs } = fakeIO()
    await new LaunchdManager(OPTS, io, '/Users/me').install()
    expect(dirs).not.toContain(OPTS.logFile)
  })
})
