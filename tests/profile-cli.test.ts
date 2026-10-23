/**
 * The profile CLI's stdout is relayed by the assistant, so it must carry only
 * the reply. Logs go to stderr (card #210). No test here reaches the network:
 * only skip, status and a set with no city are run.
 */
import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeConfiguration } from '../src/setup/finalize.js'
import { buildEmailSignature, type Answers } from '../src/setup/plan.js'
import { PERSONALITY_PRESETS } from '../src/setup/wizard.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function runCli(args: string[], root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      // Run tsx's own entry through this Node: the .bin shim is tsx.cmd on Windows.
      process.execPath,
      [resolve(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), resolve(REPO, 'scripts', 'profile.ts'), ...args],
      { cwd: REPO, env: { ...process.env, AGENT_PROJECT_ROOT: root, AGENT_STORE_DIR: join(root, 'store'), LOG_LEVEL: 'info' }, timeout: 60_000 },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  })
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'profile-cli-home-'))
  cpSync(resolve(REPO, 'templates'), join(root, 'templates'), { recursive: true })
  const answers: Answers = {
    ownerName: 'the owner',
    assistantName: 'Atlas',
    timezone: 'America/New_York',
    city: '',
    platform: 'Telegram',
    engine: 'subscription',
    personalityVibe: PERSONALITY_PRESETS[1]!,
    ownerBio: '',
    emailProvider: 'Skip for now',
    emailAddress: '',
    gmailAddress: '',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: buildEmailSignature({ name: 'the owner', title: '', phone: '', email: '' }),
    latitude: '40.71',
    longitude: '-74.01',
    tempUnit: 'celsius',
    monthlyAudit: false,
    skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    keys: {},
    projectPath: root,
  }
  writeConfiguration(answers, {}, root, home, { profilePending: true })
  return root
}

describe('profile CLI', () => {
  it('status, skip, then status again', async () => {
    const root = project()
    const first = await runCli(['status'], root)
    expect(first.code).toBe(0)
    expect(first.stdout).toBe('Profile: pending. Owner: the owner. Assistant: Atlas. City: none. Time zone: America/New_York.\n')
    expect(first.stdout).not.toContain('{"level"')

    const skip = await runCli(['skip'], root)
    expect(skip.code).toBe(0)
    expect(skip.stdout).toBe('Skipped. You can still tell me your name, city or how to talk any time.\n')

    const after = await runCli(['status'], root)
    expect(after.stdout.startsWith('Profile: set.')).toBe(true)
  }, 60_000)

  it('set with no city makes no lookup and prints only Saved.', async () => {
    const root = project()
    const res = await runCli(['set', '--owner-name', 'Jane'], root)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('Saved.\n')
    expect(res.stdout).not.toContain('{"level"')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toContain("You are Jane's personal AI assistant")
    const status = await runCli(['status'], root)
    expect(status.stdout).toContain('Profile: set. Owner: Jane.')
  }, 60_000)

  it('treats a blank city as absent: no lookup, no weather line', async () => {
    const root = project()
    const res = await runCli(['set', '--owner-name', 'Jane', '--city', ''], root)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('Saved.\n')
  }, 60_000)

  it('prints an InputError as the only stdout line with exit code 1', async () => {
    const root = project()
    const res = await runCli(['set', '--owner-name', 'Ja"ne'], root)
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('That name cannot be used. Use 80 characters or fewer, with no quotation marks or backslashes.\n')
  }, 60_000)

  it('rejects an unknown command and an empty set', async () => {
    const root = project()
    expect((await runCli(['nope'], root)).code).toBe(1)
    const empty = await runCli(['set'], root)
    expect(empty.code).toBe(1)
    expect(empty.stdout.split('\n').filter(Boolean)).toHaveLength(1)
  }, 60_000)
})

describe('CLAUDE.md template', () => {
  it('points the assistant at the profile command', () => {
    const root = project()
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf-8')
    expect(claude).toContain('node dist/scripts/profile.js set')
    expect(claude).toContain("the owner's profile")
  })
})
