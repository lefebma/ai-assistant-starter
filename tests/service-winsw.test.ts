import { describe, it, expect, vi } from 'vitest'
import { buildWinswXml, parseWinswStatus, winswXmlPath, WinswManager } from '../src/service/winsw.js'
import { resolveServiceManager } from '../src/service/index.js'
import type { ServiceIO } from '../src/service/types.js'

const OPTS = {
  label: 'com.ai-assistant.service',
  name: 'ai-assistant',
  nodePath: 'C:\\app\\runtime\\node.exe',
  entry: 'C:\\app\\dist\\src\\index.js',
  cwd: 'C:\\app',
  logFile: 'C:\\app\\logs\\service.log',
}

describe('buildWinswXml', () => {
  const xml = buildWinswXml(OPTS)

  it('carries id, executable, arguments, working dir, and restart policy', () => {
    expect(xml).toContain('<id>ai-assistant</id>')
    expect(xml).toContain('<executable>C:\\app\\runtime\\node.exe</executable>')
    expect(xml).toContain('<arguments>"C:\\app\\dist\\src\\index.js"</arguments>')
    expect(xml).toContain('<workingdirectory>C:\\app</workingdirectory>')
    expect(xml).toContain('<onfailure action="restart"')
  })

  it('escapes XML-special characters', () => {
    const x = buildWinswXml({ ...OPTS, cwd: 'C:\\a&b<c>' })
    expect(x).toContain('C:\\a&amp;b&lt;c&gt;')
  })
})

describe('parseWinswStatus', () => {
  it('maps winsw status output', () => {
    expect(parseWinswStatus(0, 'Started')).toBe('running')
    expect(parseWinswStatus(0, 'Stopped')).toBe('stopped')
    expect(parseWinswStatus(0, 'NonExistent')).toBe('not-installed')
    expect(parseWinswStatus(1, '')).toBe('not-installed')
  })
})

describe('winswXmlPath', () => {
  it('is the sibling xml with the same basename', () => {
    expect(winswXmlPath('C:\\app\\tools\\winsw\\ai-service.exe')).toBe('C:\\app\\tools\\winsw\\ai-service.xml')
  })
})

function fakeIO(existsMap: Record<string, boolean> = {}) {
  const writes: Array<{ path: string }> = []
  const execCalls: string[] = []
  const io: ServiceIO = {
    exec: vi.fn(async (cmd: string, args: string[]) => {
      execCalls.push(`${cmd} ${args.join(' ')}`)
      return { code: 0, out: '' }
    }),
    writeFile: (path) => void writes.push({ path }),
    removeFile: () => {},
    exists: (path) => existsMap[path] ?? false,
  }
  return { io, writes, execCalls }
}

describe('WinswManager', () => {
  it('install writes the sibling xml then installs and starts via the exe', async () => {
    const { io, writes, execCalls } = fakeIO()
    const exe = 'C:\\app\\tools\\winsw\\ai-service.exe'
    await new WinswManager(OPTS, io, exe).install()
    expect(writes[0].path).toBe('C:\\app\\tools\\winsw\\ai-service.xml')
    expect(execCalls).toEqual([`${exe} install`, `${exe} start`])
  })
})

describe('resolveServiceManager on win32', () => {
  it('prefers winsw when the bundled exe exists, falls back to schtasks otherwise', () => {
    const exe = 'C:\\app\\tools\\winsw\\ai-service.exe'
    const withExe = fakeIO({ [exe]: true })
    expect(resolveServiceManager('win32', { ...OPTS, winswExe: exe }, withExe.io).kind).toBe('winsw')
    const without = fakeIO({})
    expect(resolveServiceManager('win32', { ...OPTS, winswExe: exe }, without.io).kind).toBe('schtasks')
    expect(resolveServiceManager('win32', OPTS, without.io).kind).toBe('schtasks')
  })
})
