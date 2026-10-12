import { describe, it, expect } from 'vitest'
import { setupLauncherFiles, resolveAppName } from '../src/service/launcher.js'

describe('resolveAppName', () => {
  // The setup launcher is named at build time and the restart launcher at run
  // time. Nothing carried the name between them, so a Havn bundle shipped
  // "Setup Havn.command" next to "Restart AI Assistant.app".
  it('prefers an explicit APP_NAME from the environment', () => {
    expect(resolveAppName('Havn', 'Something Else')).toBe('Havn')
  })

  it('falls back to the name stamped in at build time', () => {
    expect(resolveAppName(undefined, 'Havn')).toBe('Havn')
  })

  it('trims the trailing newline a file read leaves behind', () => {
    // Otherwise the launcher becomes "Restart Havn\n.app".
    expect(resolveAppName(undefined, 'Havn\n')).toBe('Havn')
  })

  it('ignores blank values rather than producing an empty name', () => {
    expect(resolveAppName('', '  ')).toBe('AI Assistant')
  })

  it('defaults to the generic name when nothing is set', () => {
    expect(resolveAppName(undefined, undefined)).toBe('AI Assistant')
  })
})

describe('setupLauncherFiles on macOS', () => {
  const files = setupLauncherFiles('darwin', { appName: 'Havn' })
  const script = files.find((f) => f.path.endsWith('/Contents/MacOS/setup'))!
  const plist = files.find((f) => f.path.endsWith('/Contents/Info.plist'))!

  it('ships a Setup .app that opens the browser, not a Terminal .command (#215)', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'Setup Havn.app/Contents/Info.plist',
      'Setup Havn.app/Contents/MacOS/setup',
    ])
    expect(script.content).toContain('dist/scripts/setup-web.js" --background')
    expect(script.content).not.toContain('setup.js"')
  })

  it('never scripts Terminal, so there is no automation consent prompt', () => {
    expect(script.content).not.toMatch(/Terminal/)
  })

  it('names its executable in the plist and marks it executable', () => {
    expect(plist.content).toContain('<string>setup</string>')
    expect(plist.content).toContain('com.havn.setup')
    expect(script.executable).toBe(true)
  })

  it('resolves the install folder from its own location', () => {
    // The installer decides where this lands, and the customer can move the
    // folder afterwards. Baking an absolute path in at build time breaks both.
    expect(script.content).toContain('dirname "$0")/../../..')
    expect(script.content).not.toMatch(/\/Users\/|\/Applications\//)
    expect(script.content).toContain('runtime/bin/node')
  })

  it('passes dialog text to osascript as an argument, never spliced in', () => {
    expect(script.content).toContain('item 1 of argv')
    expect(script.content).toContain('"$MSG"')
    expect(script.content).toMatch(/3\) MSG=.*already set up/)
    expect(script.content).toMatch(/4\) MSG=.*setup port/)
  })
})

describe('setupLauncherFiles on Windows', () => {
  const files = setupLauncherFiles('win32', { appName: 'Havn' })

  it('ships a double-clickable command file', () => {
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('Setup Havn.cmd')
  })

  it('starts the web setup in the background with the bundled runtime', () => {
    expect(files[0].content).toContain('%~dp0')
    expect(files[0].content).toContain('runtime\\node.exe')
    expect(files[0].content).toContain('setup-web.js" --background')
  })

  it('only keeps the window open when something went wrong', () => {
    // errorlevel N means "N or higher", so the specific codes come first.
    const c = files[0].content
    expect(c.indexOf('errorlevel 4')).toBeLessThan(c.indexOf('errorlevel 3'))
    expect(c.indexOf('errorlevel 3')).toBeLessThan(c.indexOf('errorlevel 1'))
    expect(c.match(/pause/gi)).toHaveLength(3)
  })
})

describe('setupLauncherFiles on Linux', () => {
  it('keeps the terminal wizard as an executable shell script', () => {
    const files = setupLauncherFiles('linux', { appName: 'Havn' })
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('setup-havn.sh')
    expect(files[0].executable).toBe(true)
  })
})
