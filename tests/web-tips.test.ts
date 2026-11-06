/** The quiet tip card in the web app (card #273): a card, never a popup, main chat only. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const APP = resolve(ROOT, 'public', 'app')
const html = readFileSync(resolve(APP, 'index.html'), 'utf-8')
const js = readFileSync(resolve(APP, 'app.js'), 'utf-8')
const routes = readFileSync(resolve(ROOT, 'src', 'web', 'tips-routes.ts'), 'utf-8')

describe('the tip card', () => {
  it('starts hidden and has every element the script reaches for', () => {
    expect(html).toMatch(/<div id="tip-card"[^>]*\shidden>/)
    const used = new Set([...js.matchAll(/\$\('(tip-[\w-]+)'\)/g)].map((m) => m[1]))
    expect(used.size).toBeGreaterThanOrEqual(5)
    for (const id of used) expect(html, id).toContain(`id="${id}"`)
  })

  it('writes tip text as text, not markup', () => {
    expect(js).toMatch(/\$\('tip-text'\)\.textContent/)
    expect(js).not.toMatch(/\$\('tip-text'\)\.innerHTML/)
  })

  it('is registered and limited to the main chat', () => {
    expect(readFileSync(resolve(ROOT, 'src', 'web', 'index.ts'), 'utf-8')).toContain("import './tips-routes.js'")
    expect(routes).toContain("ctx.chatId === PRIMARY_CHAT_ID ? webTip() : null")
    expect(routes).toContain("if (ctx.chatId !== PRIMARY_CHAT_ID) return sendError(ctx.res, 403, 'forbidden')")
  })
})
