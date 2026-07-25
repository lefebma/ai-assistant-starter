import { describe, it, expect } from 'vitest'
import { buildPlist, parseLaunchctlList } from '../src/service/launchd.js'
import { buildUnit, parseIsActive } from '../src/service/systemd.js'
import { buildCreateArgs, parseQuery } from '../src/service/schtasks.js'

const OPTS = {
  label: 'com.ai-assistant.service',
  name: 'ai-assistant',
  nodePath: '/usr/local/bin/node',
  entry: '/home/user/my assistant/dist/src/index.js', // space on purpose
  cwd: '/home/user/my assistant',
  logFile: '/home/user/my assistant/logs/service.log',
}

describe('launchd plist', () => {
  const plist = buildPlist(OPTS)

  it('carries label, program arguments, working dir, and log paths', () => {
    expect(plist).toContain('<string>com.ai-assistant.service</string>')
    expect(plist).toContain('<string>/usr/local/bin/node</string>')
    expect(plist).toContain('<string>/home/user/my assistant/dist/src/index.js</string>')
    expect(plist).toContain('<string>/home/user/my assistant</string>')
    expect(plist).toContain('<string>/home/user/my assistant/logs/service.log</string>')
  })

  it('keeps the service alive and starts at load', () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it('escapes XML-special characters in paths', () => {
    const p = buildPlist({ ...OPTS, cwd: '/tmp/a&b<c>' })
    expect(p).toContain('/tmp/a&amp;b&lt;c&gt;')
    expect(p).not.toContain('a&b<c>')
  })
})

describe('parseLaunchctlList', () => {
  it('not-installed when launchctl list fails', () => {
    expect(parseLaunchctlList(1, '')).toBe('not-installed')
  })

  it('running when the job has a PID', () => {
    expect(parseLaunchctlList(0, '{\n\t"PID" = 12345;\n\t"Label" = "com.x";\n}')).toBe('running')
  })

  it('stopped when installed but no PID', () => {
    expect(parseLaunchctlList(0, '{\n\t"LastExitStatus" = 0;\n\t"Label" = "com.x";\n}')).toBe('stopped')
  })
})

describe('systemd unit', () => {
  const unit = buildUnit(OPTS)

  it('carries exec, working dir, and restart policy', () => {
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/home/user/my assistant/dist/src/index.js"')
    expect(unit).toContain('WorkingDirectory=/home/user/my assistant')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })
})

describe('parseIsActive', () => {
  it('maps systemctl is-active output', () => {
    expect(parseIsActive(0, 'active\n')).toBe('running')
    expect(parseIsActive(3, 'inactive\n')).toBe('stopped')
    expect(parseIsActive(4, 'inactive\n')).toBe('not-installed')
  })
})

describe('schtasks create args', () => {
  it('registers an onlogon task running node with the entry', () => {
    const args = buildCreateArgs(OPTS)
    expect(args[0]).toBe('/create')
    expect(args).toContain('/tn')
    expect(args[args.indexOf('/tn') + 1]).toBe('ai-assistant')
    expect(args).toContain('/sc')
    expect(args[args.indexOf('/sc') + 1]).toBe('onlogon')
    const tr = args[args.indexOf('/tr') + 1]
    expect(tr).toContain('"/usr/local/bin/node"')
    expect(tr).toContain('"/home/user/my assistant/dist/src/index.js"')
    expect(args).toContain('/f')
  })
})

describe('parseQuery (schtasks)', () => {
  it('maps schtasks query output', () => {
    expect(parseQuery(1, 'ERROR: The system cannot find the file specified.')).toBe('not-installed')
    expect(parseQuery(0, 'TaskName: \\ai-assistant\nStatus: Running')).toBe('running')
    expect(parseQuery(0, 'TaskName: \\ai-assistant\nStatus: Ready')).toBe('stopped')
  })
})
