import { describe, it, expect } from 'vitest'
import { resolveChromePath } from '../src/browser.js'

const only = (...found: string[]) => (p: string) => found.includes(p)
const none = () => false

describe('resolveChromePath', () => {
  it('finds the system Chrome on macOS', () => {
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(resolveChromePath('darwin', only(macChrome))).toBe(macChrome)
  })

  it('finds Chrome on Windows, which the old macOS-only constant never could', () => {
    const winChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    expect(resolveChromePath('win32', only(winChrome))).toBe(winChrome)
  })

  it('falls back to the 32-bit Windows location', () => {
    const win32Chrome = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    expect(resolveChromePath('win32', only(win32Chrome))).toBe(win32Chrome)
  })

  it('accepts chromium on Linux', () => {
    expect(resolveChromePath('linux', only('/usr/bin/chromium'))).toBe('/usr/bin/chromium')
  })

  it('prefers the system install when several candidates exist', () => {
    const found = resolveChromePath('linux', () => true)
    expect(found).toBe('/usr/bin/google-chrome')
  })

  it('returns null rather than a bogus path when Chrome is absent', () => {
    // launchChrome relies on this to log a real reason instead of spawning ENOENT.
    expect(resolveChromePath('darwin', none)).toBeNull()
    expect(resolveChromePath('win32', none)).toBeNull()
  })

  it('returns null on an unknown platform instead of throwing', () => {
    expect(resolveChromePath('aix', () => true)).toBeNull()
  })
})
