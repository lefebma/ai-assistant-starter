import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjects, projectFraming } from '../src/web/projects.js'

let root = ''
const state = (rel: string, fm: string) => {
  mkdirSync(join(root, 'projects', rel), { recursive: true })
  writeFileSync(join(root, 'projects', rel, 'STATE.md'), fm)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'web-projects-'))
})

describe('listProjects', () => {
  it('returns nothing without a projects dir', () => {
    expect(listProjects(root)).toEqual([])
  })

  it('finds nested dirs, applies id and name rules, and sorts by company then name', () => {
    state('acme/website', '---\nproject: Website Relaunch\ncompany: acme\nstatus: active\n---\n# x')
    state('acme/alpha', '---\nname: "Alpha"\nid: alpha-id\ncompany: acme\n---\n')
    state('personal/side/deep/thing', 'no frontmatter')
    state('zeta/plan', '---\ncompany: Beta Co\n---\n')
    const list = listProjects(root)
    expect(list.map((p) => p.id)).toEqual(['alpha-id', 'acme-website', 'zeta-plan', 'personal-side-deep-thing'])
    expect(list[0]).toEqual({ id: 'alpha-id', name: 'Alpha', company: 'acme', status: '', statePath: 'projects/acme/alpha/STATE.md' })
    expect(list[1]).toMatchObject({ name: 'Website Relaunch', status: 'active' })
    expect(list[2]).toMatchObject({ name: 'plan', company: 'Beta Co' })
    expect(list[3]).toMatchObject({ name: 'thing', company: 'personal' })
  })

  it('skips dot dirs, node_modules, a root STATE.md, symlinked dirs and anything past depth 4', () => {
    writeFileSync(join(root, 'projects-placeholder'), '')
    mkdirSync(join(root, 'projects'), { recursive: true })
    writeFileSync(join(root, 'projects', 'STATE.md'), '')
    state('.hidden/p', '')
    state('node_modules/p', '')
    state('a/b/c/d', '')
    state('a/b/c/d/e', '')
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'projects', 'link'))
    expect(listProjects(root).map((p) => p.id)).toEqual(['a-b-c-d'])
  })
})

describe('projectFraming', () => {
  it('is empty for General and unknown ids', () => {
    state('acme/website', '---\nproject: Site\n---\n')
    expect(projectFraming('', root)).toBe('')
    expect(projectFraming('nope', root)).toBe('')
  })

  it('names the project and its state file, with no angle brackets', () => {
    state('acme/website', '---\nproject: Site <b>"x"</b>\n---\n')
    const f = projectFraming('acme-website', root)
    expect(f).toContain('project "Site b x /b"')
    expect(f).toContain('projects/acme/website/STATE.md')
    expect(f).not.toMatch(/[<>]/)
  })
})
