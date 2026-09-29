import { describe, it, expect } from 'vitest'
import { chromeChannelInstalled, playwrightMcpBrowserArgs } from '../src/browser-channel.js'

const only = (...found: string[]) => (p: string) => found.includes(p)
const none = () => false

describe('chromeChannelInstalled', () => {
  it('finds Google Chrome where Playwright looks for it on Linux', () => {
    expect(chromeChannelInstalled('linux', only('/opt/google/chrome/chrome'))).toBe(true)
  })

  it('does not count a distro Chromium as the chrome channel', () => {
    // resolveChromePath accepts /usr/bin/chromium for /browser start, but
    // Playwright's "chrome" channel only ever looks at /opt/google/chrome.
    expect(chromeChannelInstalled('linux', only('/usr/bin/chromium', '/usr/bin/chromium-browser'))).toBe(false)
  })

  it('finds Google Chrome on macOS', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(chromeChannelInstalled('darwin', only(mac))).toBe(true)
  })

  it('checks each Windows install prefix Playwright checks', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' }
    const perUser = 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    expect(chromeChannelInstalled('win32', only(perUser), env)).toBe(true)
    expect(chromeChannelInstalled('win32', none, env)).toBe(false)
  })

  it('skips Windows prefixes that are not set rather than probing "undefined\\..."', () => {
    const probed: string[] = []
    chromeChannelInstalled('win32', (p) => { probed.push(p); return false }, { PROGRAMFILES: 'C:\\Program Files' })
    expect(probed).toEqual(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'])
  })

  it('returns false on an unknown platform', () => {
    expect(chromeChannelInstalled('aix', () => true)).toBe(false)
  })
})

describe('playwrightMcpBrowserArgs', () => {
  it('attaches to a running debuggable browser when there is one', () => {
    expect(playwrightMcpBrowserArgs({ cdpUp: true, chromeInstalled: false, passthrough: [] }))
      .toEqual(['--cdp-endpoint', 'http://127.0.0.1:9222'])
  })

  it('leaves the default alone when Google Chrome is installed', () => {
    expect(playwrightMcpBrowserArgs({ cdpUp: false, chromeInstalled: true, passthrough: [] })).toEqual([])
  })

  it('falls back to the bundled Chromium when Google Chrome is absent', () => {
    // A hosted VPS has no Chrome; the MCP default ("chrome") failed every call
    // with "Chromium distribution 'chrome' is not found" (havn-test, 2026-09-28).
    expect(playwrightMcpBrowserArgs({ cdpUp: false, chromeInstalled: false, passthrough: [] }))
      .toEqual(['--browser', 'chromium'])
  })

  it('never overrides a --browser the operator passed explicitly', () => {
    expect(playwrightMcpBrowserArgs({ cdpUp: false, chromeInstalled: false, passthrough: ['--browser', 'firefox'] })).toEqual([])
    expect(playwrightMcpBrowserArgs({ cdpUp: false, chromeInstalled: false, passthrough: ['--browser=msedge'] })).toEqual([])
  })
})
