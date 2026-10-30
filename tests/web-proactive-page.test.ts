import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const APP = resolve(__dirname, '..', 'public', 'app')
const html = readFileSync(resolve(APP, 'index.html'), 'utf-8')
const js = readFileSync(resolve(APP, 'app.js'), 'utf-8')

describe('proactive messages in Settings (card #262)', () => {
  it('has a section, hidden until the settings load', () => {
    expect(html).toMatch(/<section id="pro-section"[^>]*\shidden>/)
  })

  it('has every element the script reaches for', () => {
    const used = new Set([...js.matchAll(/\$\('(pro-[\w-]+)'\)/g)].map((m) => m[1]))
    expect(used.size).toBeGreaterThan(5)
    for (const id of used) expect(html, id).toContain(`id="${id}"`)
  })

  it('loads and saves through the one settings route, for the primary chat only', () => {
    expect(js).toContain("api.get('/api/web/proactive')")
    expect(js).toContain("api.post('/api/web/proactive', change)")
    expect(js).toMatch(/if \(!state\.me \|\| !state\.me\.isPrimary\) return show\(\$\('pro-section'\), false\)/)
  })

  it('says quiet hours also hold email alerts', () => {
    expect(html).toContain('Quiet hours also hold email alerts.')
  })
})
