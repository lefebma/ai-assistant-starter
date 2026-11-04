/**
 * /help has to be readable where it is shown.
 *
 * It was one command per line joined with single newlines, which Teams renders
 * as one paragraph: a wall of text with every command run into the next. These
 * tests pin the shape (a heading per group, one list item per command) and
 * check it through the Teams converter, the platform that exposed it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHelpText, HELP_GROUPS } from '../src/help-text.js'
import { formatForTeams } from '../src/platform/teams/activities.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

describe('/help text', () => {
  const text = buildHelpText()

  it('lists every command in the menu, so a new command cannot go missing', () => {
    const bot = readFileSync(resolve(SRC, 'bot.ts'), 'utf-8')
    const menu = bot.slice(bot.indexOf('export const COMMAND_MENU'))
    const commands = [...menu.slice(0, menu.indexOf('\n]')).matchAll(/command: '([a-z]+)'/g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThan(15)
    for (const c of commands) expect(text, `/${c} is in the menu but not in /help`).toContain(`/${c}`)
  })

  it('is one list item per command under a bold group heading', () => {
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    for (const line of lines) expect(line).toMatch(/^(\*\*[^*]+\*\*|- \/[a-z]+.*: .+)$/)
    expect(lines.filter((l) => l.startsWith('**'))).toHaveLength(HELP_GROUPS.length)
  })

  it('never runs two list items onto one line', () => {
    for (const line of text.split('\n')) expect((line.match(/(^|\s)- \//g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it('stays one command to a line after the Teams conversion', () => {
    const teams = formatForTeams(text)
    const commandLines = teams.split('\n').filter((l) => /^- \//.test(l))
    expect(commandLines).toHaveLength(HELP_GROUPS.reduce((n, g) => n + g.items.length, 0))
    for (const line of teams.split('\n')) expect((line.match(/(^|\s)- \//g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it('has no em dashes', () => {
    expect(text).not.toContain('—')
  })
})
