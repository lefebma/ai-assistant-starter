import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP = resolve(__dirname, '..', 'public', 'app')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const files = walk(APP)
const text = files.filter((f) => /\.(html|js|css|svg|webmanifest)$/.test(f)).map((f) => ({ f, body: readFileSync(f, 'utf-8') }))

describe('public/app static rules', () => {
  it('has the page files', () => {
    for (const name of ['index.html', 'app.css', 'app.js', 'api.js', 'markdown.js', 'icon.svg']) {
      expect(files.map((f) => f.slice(APP.length + 1))).toContain(name)
    }
  })

  it('has no inline script anywhere', () => {
    for (const { f, body } of text) {
      for (const tag of body.match(/<script\b[^>]*>/gi) ?? []) {
        expect(tag, f).toMatch(/\ssrc="/)
      }
    }
  })

  it('has no style elements, style attributes or event-handler attributes', () => {
    for (const { f, body } of text) {
      expect(body, f).not.toMatch(/<style\b/i)
      expect(body, f).not.toMatch(/\sstyle\s*=/i)
      expect(body, f).not.toMatch(/\son\w+\s*=/i)
    }
  })

  it('loads every script as a same-origin module', () => {
    const html = readFileSync(join(APP, 'index.html'), 'utf-8')
    const tags = html.match(/<script\b[^>]*>/gi) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) {
      expect(tag).toMatch(/\stype="module"/)
      const src = tag.match(/\ssrc="([^"]+)"/)?.[1] ?? ''
      expect(src).toMatch(/^\/app\/[\w.-]+\.js$/)
    }
  })

  it('links only same-origin stylesheets and no external URLs in code', () => {
    const html = readFileSync(join(APP, 'index.html'), 'utf-8')
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      expect(tag).toMatch(/\shref="\/app\//)
    }
    for (const { f, body } of text) {
      if (f.endsWith('.svg')) continue
      expect(body, f).not.toMatch(/(?:src|href)="https?:/i)
      expect(body, f).not.toMatch(/@import/)
    }
  })

  it('never sets styles or raw HTML attributes from script', () => {
    for (const { f, body } of text.filter((t) => t.f.endsWith('.js'))) {
      expect(body, f).not.toMatch(/setAttribute\(\s*['"](?:style|on\w+)['"]/)
      expect(body, f).not.toMatch(/\.style\./)
      expect(body, f).not.toMatch(/\beval\(|new Function\(/)
    }
  })

  it('contains no em dash', () => {
    for (const { f, body } of text) {
      expect(body.includes('—'), f).toBe(false)
    }
  })
})
