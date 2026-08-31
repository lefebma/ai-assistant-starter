/**
 * tests/skill-visibility.test.ts
 *
 * A skill on disk that the running process cannot see.
 *
 * havn-test updated to 1.19.0 and then told its owner "No interview skill
 * here" while templates/skills/exec-interview sat in the tree. Two separate
 * things produced that, and both are cheap to regress:
 *
 * 1. The skill registry is built while bot.js is being imported, and
 *    syncAlwaysOnSkills() runs later, inside main(). Sixteen milliseconds
 *    apart in the logs: "Skills loaded count: 6", then "installed missing
 *    always-on skill: exec-interview". The registry is a snapshot, so the new
 *    skill was invisible for the whole life of that process. The first boot
 *    after an update is precisely when someone goes looking for what the
 *    update added, so "it appears on the second restart" is not good enough.
 *
 * 2. /version read the VERSION file, which an applied update rewrites while
 *    the old process keeps serving. The box reported v1.19.0 for two days
 *    while running 1.18.0 code, which is what made a stale registry look like
 *    a missing feature.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBootVersion, getCurrentVersion, restartPending } from '../src/updater.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
})

/**
 * A fresh loader rooted at a temp skills/ directory.
 *
 * The loader resolves its scan paths from process.cwd() once, at module load,
 * so the chdir has to happen before the import. resetModules gives each test
 * its own registry rather than sharing the suite's.
 */
async function freshLoader(): Promise<{ dir: string; loader: typeof import('../src/skills/loader.js') }> {
  const root = mkdtempSync(join(tmpdir(), 'skill-visibility-'))
  const dir = join(root, 'skills')
  mkdirSync(dir, { recursive: true })
  process.chdir(root)
  vi.resetModules()
  return { dir, loader: await import('../src/skills/loader.js') }
}

function writeSkill(dir: string, id: string, triggers: string[]): void {
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(
    join(dir, id, 'manifest.json'),
    JSON.stringify({ id, name: id, description: `${id} skill`, triggers, priority: 50 })
  )
}

describe('the skill registry is a snapshot of disk', () => {
  it('does not notice a skill written after it was built, until it is reloaded', async () => {
    const { dir, loader } = await freshLoader()
    writeSkill(dir, 'weather', ['weather'])
    expect(loader.loadSkills().map((s) => s.manifest.id)).toContain('weather')

    // This is syncAlwaysOnSkills() landing a new always-on skill during main(),
    // after bot.js was imported and built the registry.
    writeSkill(dir, 'exec-interview', ['interview me'])

    expect(loader.getSkills().map((s) => s.manifest.id)).not.toContain('exec-interview')
    expect(loader.matchSkills('interview me')).toHaveLength(0)
    expect(loader.buildSkillIndex()).not.toContain('exec-interview')

    expect(loader.reloadSkills().map((s) => s.manifest.id)).toContain('exec-interview')
    expect(loader.matchSkills('interview me').map((s) => s.manifest.id)).toEqual(['exec-interview'])
    expect(loader.buildSkillIndex()).toContain('exec-interview')
  })
})

describe('boot reloads the registry when it installs a skill', () => {
  // The reload is one line in a startup path no test can boot, so pin the
  // ordering at the source. Dropping it costs a client the first boot after
  // every update that adds an always-on skill.
  const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')

  it('calls reloadSkills after syncAlwaysOnSkills, inside the installed branch', () => {
    const sync = index.indexOf('syncAlwaysOnSkills()')
    const guard = index.indexOf('syncResult.installed.length > 0')
    const reload = index.indexOf('reloadSkills()')
    expect(sync).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(sync)
    expect(reload).toBeGreaterThan(guard)
  })

  it('imports reloadSkills', () => {
    expect(index).toMatch(/import \{[^}]*reloadSkills[^}]*\} from '\.\/skills\/index\.js'/)
  })
})

describe('the reported version is the one that is running', () => {
  it('reads the boot version from the VERSION file at import', () => {
    expect(getBootVersion()).toBe(readFileSync(join(REPO, 'VERSION'), 'utf-8').trim())
    expect(getBootVersion()).toBe(getCurrentVersion())
  })

  it('is not pending a restart when disk and process agree', () => {
    expect(restartPending(() => getBootVersion())).toBe(false)
  })

  it('is pending a restart once an update rewrites VERSION under the process', () => {
    expect(restartPending(() => '99.0.0')).toBe(true)
  })

  it('reports the running version, and names the waiting one, in /version', () => {
    const bot = readFileSync(join(REPO, 'src', 'bot.ts'), 'utf-8')
    const cmd = bot.slice(bot.indexOf("cmd === '/version'"))
    const block = cmd.slice(0, cmd.indexOf('return'))
    expect(block).toContain('restartPending()')
    expect(block).toContain('getBootVersion()')
    expect(block).toContain('next restart')
  })
})
