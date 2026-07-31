import { describe, it, expect } from 'vitest'
import { setupLauncherFiles } from '../src/service/launcher.js'

describe('setupLauncherFiles on macOS', () => {
  const files = setupLauncherFiles('darwin', { appName: 'Havn' })

  it('ships a .command, not a .app', () => {
    // A .app would need osascript to drive Terminal, which trips the macOS
    // "wants to control Terminal" consent dialog on first run — the last thing
    // to put in front of the non-technical owner this exists for. Finder runs
    // a .command in Terminal directly, no consent prompt.
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('Setup Havn.command')
  })

  it('is executable, or Finder opens it in TextEdit instead of running it', () => {
    expect(files[0].executable).toBe(true)
  })

  it('resolves everything relative to its own location', () => {
    // The installer decides where this lands, and the customer can move the
    // folder afterwards. Baking an absolute path in at build time breaks both.
    expect(files[0].content).toContain('dirname "$0"')
    expect(files[0].content).not.toMatch(/\/Users\/|\/Applications\//)
  })

  it('runs the wizard with the bundled runtime', () => {
    expect(files[0].content).toContain('runtime/bin/node')
    expect(files[0].content).toContain('dist/scripts/setup.js')
  })

  it('keeps the window open at the end so the next steps stay readable', () => {
    expect(files[0].content).toMatch(/read /)
  })
})

describe('setupLauncherFiles on Windows', () => {
  const files = setupLauncherFiles('win32', { appName: 'Havn' })

  it('ships a double-clickable command file', () => {
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('Setup Havn.cmd')
  })

  it('resolves relative to its own location via %~dp0', () => {
    expect(files[0].content).toContain('%~dp0')
    expect(files[0].content).toContain('runtime\\node.exe')
  })

  it('pauses so the window does not vanish', () => {
    expect(files[0].content).toMatch(/pause/i)
  })
})

describe('setupLauncherFiles on Linux', () => {
  it('falls back to an executable shell script', () => {
    const files = setupLauncherFiles('linux', { appName: 'Havn' })
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('setup-havn.sh')
    expect(files[0].executable).toBe(true)
  })
})
