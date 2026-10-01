/**
 * The optional slack skill template.
 *
 * Its whole point is that messages show the assistant, not the owner, so the
 * one thing that must never regress is the token check: a user token (xoxp-)
 * would post as a person. The script has to refuse anything but xoxb-, and has
 * to say plainly when no token is set rather than failing in some other way.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'skills', 'slack')
const SCRIPT = join(DIR, 'scripts', 'slack.py')
const hasPython = spawnSync('python3', ['--version']).status === 0

function run(env: Record<string, string>) {
  // Minimal env on purpose: no inherited SLACK_BOT_TOKEN, and the script's
  // .env fallback looks four directories up from the script, which here is the
  // repo root, where there is no .env in a clean checkout.
  return spawnSync('python3', [SCRIPT, 'whoami'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8' })
}

describe('slack skill template', () => {
  it('ships a valid manifest that is enabled and tells the assistant to ask before posting', () => {
    const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf-8'))
    expect(m.id).toBe('slack')
    expect(m.enabled).toBe(true)
    expect(m.context).toContain('slack.py')
    expect(m.context).toContain('wait for approval')
    expect(m.context).toContain('{{PROJECT_PATH}}')
  })

  it('ships an app manifest with no scope that lets the bot post under another name', () => {
    const app = JSON.parse(readFileSync(join(DIR, 'slack-app-manifest.json'), 'utf-8'))
    expect(app.oauth_config.scopes.bot).toContain('chat:write')
    expect(app.oauth_config.scopes.bot).not.toContain('chat:write.customize')
    expect(app.oauth_config.scopes.user).toBeUndefined()
  })

  it('has its script and setup notes', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    expect(existsSync(join(DIR, 'SKILL.md'))).toBe(true)
  })

  it.skipIf(!hasPython)('says plainly when no token is set', () => {
    const r = run({})
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('SLACK_BOT_TOKEN is not set')
  })

  it.skipIf(!hasPython)('refuses a token that is not a bot token', () => {
    const r = run({ SLACK_BOT_TOKEN: 'xoxp-a-user-token' })
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('must be a bot token')
  })
})
