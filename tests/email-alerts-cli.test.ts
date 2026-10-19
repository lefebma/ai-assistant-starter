/**
 * The email-alerts CLI's stdout is relayed to the owner word for word, so it
 * must carry only the reply. Logs go to stderr.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
})

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      resolve(REPO, 'node_modules', '.bin', 'tsx'),
      [resolve(REPO, 'scripts', 'email-alerts.ts'), ...args],
      { cwd: REPO, env: { ...process.env, ...env }, timeout: 60_000 },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  })
}

describe('email-alerts CLI', () => {
  it('prints only the reply on stdout, with log lines on stderr', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'havn-email-alerts-cli-'))
    const env = {
      AGENT_STORE_DIR: join(tmp, 'store'),
      AGENT_VAULT_DIR: join(tmp, 'vault'),
      GOG_BIN: join(tmp, 'no-gog'),
      LOG_LEVEL: 'info',
    }
    const res = await runCli(['status'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe(
      [
        'Email alerts are off.',
        'Quiet hours: 22:00 to 07:00.',
        'VIPs: 0. Muted: 0.',
        'Last 7 days: 0 alerts, 0 marked useful, 0 not urgent',
        'No Gmail or Outlook mailbox is connected.',
        '',
      ].join('\n')
    )
    // The CLI logs one counts-free line per run, so a log line is known to exist.
    expect(res.stderr).toContain('email-alerts control')
  }, 60_000)
})

describe('email-alerts skill triggers', () => {
  it('match the owner phrasings through the loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'havn-email-alerts-skill-'))
    mkdirSync(join(root, 'skills'), { recursive: true })
    cpSync(resolve(REPO, 'templates', 'skills', 'email-alerts'), join(root, 'skills', 'email-alerts'), { recursive: true })
    process.chdir(root)
    vi.resetModules()
    const loader = await import('../src/skills/loader.js')
    loader.loadSkills()
    for (const msg of [
      'always tell me when jane@acme.com writes',
      'stop alerting me about acme.com',
      'turn on email alerts',
      'pause my email alerts for an hour',
      'email alert status',
    ]) {
      expect(loader.matchSkills(msg).map((s) => s.manifest.id), msg).toContain('email-alerts')
    }
  })
})
