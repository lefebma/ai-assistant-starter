/**
 * tests/self-restart.test.ts
 *
 * `/update apply` used to end with "Restart the service to activate", which on
 * a hosted box is an instruction the client cannot follow: there is no terminal
 * there. havn-test ran 1.18.0 code for two days with 1.19.0 on disk because of
 * it, and the only visible symptom was that the update seemed not to have
 * worked.
 *
 * So the app restarts itself, by exiting and letting its supervisor bring it
 * back. The whole risk of that lives in one question: is a supervisor really
 * there? A false yes ends the assistant with nothing to start it again, which
 * is far worse than the instruction it replaces. These tests pin the detection
 * against the environments it actually has to tell apart, and pin the exit code
 * that decides whether a Restart=on-failure unit treats the exit as a stop.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESTART_EXIT_CODE, canSelfRestart, detectSupervisor } from '../src/service/supervisor.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('detectSupervisor', () => {
  it('sees systemd by INVOCATION_ID, which covers system and user units alike', () => {
    // A user unit is parented to `systemd --user`, not PID 1, so the parent
    // check would miss it. This is the signal that catches both.
    expect(detectSupervisor({ env: { INVOCATION_ID: 'abc' }, platform: 'linux', ppid: 1 })).toBe('systemd')
    expect(detectSupervisor({ env: { INVOCATION_ID: 'abc' }, platform: 'linux', ppid: 4242 })).toBe('systemd')
  })

  it('sees launchd by the job label, and by PID 1 parentage', () => {
    // Measured on macOS 15: a running LaunchAgent has XPC_SERVICE_NAME set to
    // its label and ppid 1.
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: 'com.havn.service' }, platform: 'darwin', ppid: 1 })).toBe('launchd')
    expect(detectSupervisor({ env: {}, platform: 'darwin', ppid: 1 })).toBe('launchd')
  })

  it('does not mistake a Terminal session for launchd', () => {
    // Measured in the same session: an interactive shell reports
    // XPC_SERVICE_NAME=0 and a real parent.
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: '0' }, platform: 'darwin', ppid: 36068 })).toBe('none')
  })

  it('reports none for a bare foreground run', () => {
    expect(detectSupervisor({ env: {}, platform: 'linux', ppid: 4242 })).toBe('none')
    expect(detectSupervisor({ env: {}, platform: 'darwin', ppid: 4242 })).toBe('none')
  })

  it('reports none on Windows, where the fallback logon task has no supervision', () => {
    // Exiting under a Task Scheduler logon task ends the assistant for good.
    expect(detectSupervisor({ env: {}, platform: 'win32', ppid: 1 })).toBe('none')
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: 'x' }, platform: 'win32', ppid: 1 })).toBe('none')
  })

  it('gates the restart on a supervisor being found', () => {
    expect(canSelfRestart({ env: { INVOCATION_ID: 'abc' }, platform: 'linux', ppid: 1 })).toBe(true)
    expect(canSelfRestart({ env: {}, platform: 'linux', ppid: 4242 })).toBe(false)
  })
})

describe('the restart exit code', () => {
  it('is non-zero, so a Restart=on-failure unit does not treat it as a clean stop', () => {
    // The hosted unit is Restart=always and launchd is KeepAlive, both of which
    // restart on any exit. The user unit this app installs itself is
    // on-failure, where exit 0 is final.
    expect(RESTART_EXIT_CODE).not.toBe(0)
  })

  it('is the code the polling watchdog already exits with', () => {
    const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')
    expect(index).toContain('process.exit(RESTART_EXIT_CODE)')
    expect(index).not.toMatch(/process\.exit\(43\)/)
  })
})

describe('the restart request reaches the shutdown handler', () => {
  it('changes the exit code only once it has been asked for', async () => {
    vi.resetModules()
    const restart = await import('../src/infra/restart.js')
    expect(restart.restartRequested()).toBe(false)
    expect(restart.shutdownExitCode()).toBe(0)

    restart.requestRestart()
    expect(restart.restartRequested()).toBe(true)
    expect(restart.shutdownExitCode()).toBe(RESTART_EXIT_CODE)
  })

  it('is what the shutdown handler exits with', () => {
    // Reusing the SIGTERM path matters: it is the only code that stops the
    // adapter, scheduler, HTTP server and Chrome in order and releases the PID
    // lock. A second exit path would drift from it.
    const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')
    expect(index).toContain('process.exit(shutdownExitCode())')
    expect(index).not.toMatch(/process\.exit\(0\)\s*\n\s*\}\s*\n\s*process\.on\('SIGINT'/)
  })
})

describe('/update apply', () => {
  const bot = readFileSync(join(REPO, 'src', 'bot.ts'), 'utf-8')
  const apply = bot.slice(bot.indexOf('const result = await applyUpdate()'))
  const block = apply.slice(0, apply.indexOf('await adapter.sendMessage(chatId, result.message)'))

  it('restarts only on a successful update under a real supervisor', () => {
    expect(block).toContain('result.success && canSelfRestart()')
  })

  it('flags the restart before raising the signal, so the exit code is set', () => {
    const flag = block.indexOf('requestRestart()')
    const signal = block.indexOf("process.kill(process.pid, 'SIGTERM')")
    expect(flag).toBeGreaterThan(-1)
    expect(signal).toBeGreaterThan(flag)
  })

  it('tells the client it is going away before it goes', () => {
    const send = block.indexOf('adapter.sendMessage')
    const signal = block.indexOf("process.kill(process.pid, 'SIGTERM')")
    expect(send).toBeGreaterThan(-1)
    expect(signal).toBeGreaterThan(send)
  })

  it('keeps the old instruction where nothing would bring it back', () => {
    // The unsupervised path still falls through to result.message, which ends
    // "Restart the service to activate".
    expect(bot).toContain('await adapter.sendMessage(chatId, result.message)')
  })
})
