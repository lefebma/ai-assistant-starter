import { describe, it, expect } from 'vitest'
import { launcherFiles } from '../src/service/launcher.js'

const opts = {
  appName: 'AI Assistant',
  nodePath: '/Users/sam/My Assistant/runtime/bin/node',
  cwd: '/Users/sam/My Assistant',
}

describe('launcherFiles on macOS', () => {
  const files = launcherFiles('darwin', opts)

  it('builds a double-clickable .app rather than a bare script', () => {
    expect(files.map((f) => f.path)).toContain('Restart AI Assistant.app/Contents/Info.plist')
    expect(files.map((f) => f.path)).toContain('Restart AI Assistant.app/Contents/MacOS/restart')
  })

  it('marks only the executable as executable', () => {
    const script = files.find((f) => f.path.endsWith('MacOS/restart'))
    const plist = files.find((f) => f.path.endsWith('Info.plist'))
    expect(script?.executable).toBe(true)
    expect(plist?.executable).toBe(false)
  })

  it('points Info.plist at the script that actually exists', () => {
    const plist = files.find((f) => f.path.endsWith('Info.plist'))!
    expect(plist.content).toContain('<key>CFBundleExecutable</key>')
    expect(plist.content).toContain('<string>restart</string>')
  })

  it('restarts the service through the bundled runtime', () => {
    const script = files.find((f) => f.path.endsWith('MacOS/restart'))!
    expect(script.content).toContain('/Users/sam/My Assistant/runtime/bin/node')
    expect(script.content).toContain('service.js')
    expect(script.content).toContain('restart')
  })

  it('quotes paths so a space in the install directory does not split the command', () => {
    const script = files.find((f) => f.path.endsWith('MacOS/restart'))!
    expect(script.content).toContain('"/Users/sam/My Assistant/runtime/bin/node"')
  })
})

describe('launcherFiles on Windows', () => {
  const files = launcherFiles('win32', {
    ...opts,
    nodePath: 'C:\\Users\\sam\\My Assistant\\runtime\\node.exe',
    cwd: 'C:\\Users\\sam\\My Assistant',
  })

  it('builds one double-clickable command file', () => {
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('Restart AI Assistant.cmd')
  })

  it('quotes the runtime path so Program Files style directories work', () => {
    expect(files[0].content).toContain('"C:\\Users\\sam\\My Assistant\\runtime\\node.exe"')
    expect(files[0].content).toContain('restart')
  })

  it('does not close instantly on failure, so the user can read the error', () => {
    expect(files[0].content).toMatch(/pause/i)
  })
})

describe('launcherFiles on Linux', () => {
  it('falls back to an executable shell script', () => {
    const files = launcherFiles('linux', opts)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('restart-ai-assistant.sh')
    expect(files[0].executable).toBe(true)
  })
})
