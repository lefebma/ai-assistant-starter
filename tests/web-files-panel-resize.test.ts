import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import * as pw from '../public/app/panelwidth.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const html = readFileSync(join(APP, 'index.html'), 'utf-8')
const css = readFileSync(join(APP, 'app.css'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

const mem = (init: Record<string, string> = {}) => {
  const m = { ...init }
  return {
    getItem: (k: string) => (k in m ? m[k] : null),
    setItem: (k: string, v: string) => { m[k] = v },
    removeItem: (k: string) => { delete m[k] },
  }
}

describe('clampWidth', () => {
  it('keeps a width inside the limits', () => {
    expect(pw.clampWidth(400, 1600)).toBe(400)
  })
  it('never goes below the minimum', () => {
    expect(pw.clampWidth(10, 1600)).toBe(pw.MIN_WIDTH)
  })
  it('never goes above the maximum', () => {
    expect(pw.clampWidth(5000, 1600)).toBe(pw.MAX_WIDTH)
  })
  it('leaves the chat a minimum width on a small window', () => {
    const w = pw.clampWidth(5000, 1000)
    expect(1000 - pw.LEFT_WIDTH - w).toBeGreaterThanOrEqual(pw.MIN_CHAT)
    expect(w).toBeGreaterThanOrEqual(pw.MIN_WIDTH)
  })
  it('falls back to the default for junk', () => {
    expect(pw.clampWidth(NaN, 1600)).toBe(pw.DEFAULT_WIDTH)
    expect(pw.clampWidth(undefined, 1600)).toBe(pw.DEFAULT_WIDTH)
  })
})

describe('stored width', () => {
  it('round-trips', () => {
    const s = mem()
    pw.saveWidth(s, 420)
    expect(pw.loadWidth(s, 1600)).toBe(420)
  })
  it('defaults when nothing or junk is stored', () => {
    expect(pw.loadWidth(mem(), 1600)).toBe(pw.DEFAULT_WIDTH)
    expect(pw.loadWidth(mem({ [pw.STORAGE_KEY]: 'abc' }), 1600)).toBe(pw.DEFAULT_WIDTH)
  })
  it('clamps a stored width that no longer fits', () => {
    expect(pw.loadWidth(mem({ [pw.STORAGE_KEY]: '9999' }), 1600)).toBe(pw.MAX_WIDTH)
  })
  it('survives storage that throws', () => {
    const bad = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
    expect(pw.loadWidth(bad, 1600)).toBe(pw.DEFAULT_WIDTH)
    expect(() => pw.saveWidth(bad, 400)).not.toThrow()
  })
  it('reset forgets the width', () => {
    const s = mem()
    pw.saveWidth(s, 420)
    pw.clearWidth(s)
    expect(pw.loadWidth(s, 1600)).toBe(pw.DEFAULT_WIDTH)
  })
})

describe('widthFromPointer', () => {
  it('is the distance from the pointer to the right edge of the window', () => {
    expect(pw.widthFromPointer(1200, 1600)).toBe(400)
  })
})

describe('page wiring', () => {
  it('has a labelled separator handle on the files panel', () => {
    expect(html).toMatch(/id="files-resize"[^>]*role="separator"/)
    expect(html).toMatch(/id="files-resize"[^>]*aria-orientation="vertical"/)
    expect(html).toMatch(/id="files-resize"[^>]*aria-label="Resize files panel"/)
    expect(html).toMatch(/id="files-resize"[^>]*tabindex="0"/)
  })
  it('styles the handle with a resize cursor and hides it in drawer mode', () => {
    expect(css).toMatch(/\.files-resize[^}]*cursor:\s*col-resize/)
    const narrow = css.slice(css.indexOf('@media (max-width: 899.98px)'))
    expect(narrow).toMatch(/\.files-resize\s*\{\s*display:\s*none/)
  })
  it('uses the shared module and handles keys, double click and storage', () => {
    expect(js).toContain("from './panelwidth.js'")
    expect(js).toMatch(/dblclick/)
    expect(js).toMatch(/ArrowLeft/)
    expect(js).toMatch(/ArrowRight/)
    expect(js).toMatch(/--right-w/)
  })
})
