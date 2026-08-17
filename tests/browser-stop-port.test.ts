import { describe, it, expect } from 'vitest'
import { stopChromeByPort, parseNetstatPids, parseLsofPids } from '../src/browser.js'

const PORT = 9222

/** Real `netstat -ano` output: CRLF line endings, a banner, and padded columns. */
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1080',
  '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       12345',
  '  TCP    [::1]:9222             [::]:0                 LISTENING       12345',
  '  UDP    0.0.0.0:5353           *:*                                    2200',
  '',
].join('\r\n')

/** Records what a caller tried to run and kill. */
function harness(out: string | (() => string)) {
  const ran: Array<{ cmd: string; args: string[] }> = []
  const killed: number[] = []
  return {
    ran,
    killed,
    exec: (cmd: string, args: string[]) => {
      ran.push({ cmd, args })
      return typeof out === 'function' ? out() : out
    },
    kill: (pid: number) => { killed.push(pid) },
  }
}

describe('parseNetstatPids', () => {
  it('finds the PID listening on the CDP port', () => {
    expect(parseNetstatPids(NETSTAT, PORT)).toContain(12345)
  })

  it('ignores rows for other ports', () => {
    expect(parseNetstatPids(NETSTAT, PORT)).not.toContain(1080)
  })

  it('ignores UDP rows, which have no listening state', () => {
    expect(parseNetstatPids(NETSTAT, PORT)).not.toContain(2200)
  })

  it('does not match a port that merely starts with ours', () => {
    // 92220 shares a prefix with 9222; a substring match would reap it.
    const out = '  TCP    0.0.0.0:92220          0.0.0.0:0              LISTENING       777'
    expect(parseNetstatPids(out, PORT)).toEqual([])
  })

  it('does not match a foreign address on our port', () => {
    // Our outbound connection to someone else's :9222 — killing it would reap
    // an unrelated local process.
    const out = '  TCP    192.168.1.5:51000      10.0.0.9:9222          ESTABLISHED     888'
    expect(parseNetstatPids(out, PORT)).toEqual([])
  })

  it('skips non-listening rows on our own port', () => {
    const out = '  TCP    127.0.0.1:9222         127.0.0.1:51000        ESTABLISHED     999'
    expect(parseNetstatPids(out, PORT)).toEqual([])
  })

  it('returns nothing for output with no matching rows', () => {
    expect(parseNetstatPids('Active Connections\r\n', PORT)).toEqual([])
    expect(parseNetstatPids('', PORT)).toEqual([])
  })
})

describe('parseLsofPids', () => {
  it('reads one bare PID per line', () => {
    expect(parseLsofPids('4242\n4243\n')).toContain(4242)
    expect(parseLsofPids('4242\n4243\n')).toContain(4243)
  })
})

describe('stopChromeByPort', () => {
  it('uses netstat on Windows, where lsof does not exist', () => {
    const h = harness(NETSTAT)
    stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })
    expect(h.ran[0].cmd).toBe('netstat')
  })

  it('runs netstat without a shell pipe', () => {
    // `netstat -ano | findstr` would need a shell; the repo stays shell-free.
    const h = harness(NETSTAT)
    stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })
    expect(h.ran[0].args.join(' ')).not.toContain('|')
    expect(h.ran[0].args.join(' ')).not.toContain('findstr')
  })

  it('kills the orphaned Chrome found on the port', () => {
    const h = harness(NETSTAT)
    const stopped = stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })
    expect(h.killed).toEqual([12345])
    expect(stopped).toBe(1)
  })

  it('kills a PID only once when it listens on both IPv4 and IPv6', () => {
    const h = harness(NETSTAT)
    stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })
    expect(h.killed).toHaveLength(1)
  })

  it('still uses lsof off Windows', () => {
    const h = harness('4242\n')
    const stopped = stopChromeByPort({ platform: 'darwin', exec: h.exec, kill: h.kill })
    expect(h.ran[0].cmd).toBe('lsof')
    expect(h.killed).toEqual([4242])
    expect(stopped).toBe(1)
  })

  it('reports nothing stopped when the port is free', () => {
    const h = harness('')
    expect(stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })).toBe(0)
    expect(h.killed).toEqual([])
  })

  it('degrades quietly when the lookup tool is missing', () => {
    // execFileSync throws ENOENT when netstat/lsof is not on PATH.
    const h = harness(() => { throw new Error('ENOENT') })
    expect(() => stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })).not.toThrow()
    expect(stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })).toBe(0)
  })

  it('never targets PID 0', () => {
    // The Windows Idle process; on POSIX, kill(0) signals our own process group.
    const h = harness('  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       0')
    expect(stopChromeByPort({ platform: 'win32', exec: h.exec, kill: h.kill })).toBe(0)
    expect(h.killed).toEqual([])
  })

  it('counts only processes that were really signalled', () => {
    // A process that exited between the lookup and the kill throws ESRCH.
    const h = harness(NETSTAT)
    const stopped = stopChromeByPort({
      platform: 'win32',
      exec: h.exec,
      kill: () => { throw new Error('ESRCH') },
    })
    expect(stopped).toBe(0)
  })
})
