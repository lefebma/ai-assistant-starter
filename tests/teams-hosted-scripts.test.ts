import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENABLE = join(ROOT, 'scripts', 'hosted', 'enable-teams.sh')

describe('enable-teams.sh', () => {
  const text = () => readFileSync(ENABLE, 'utf-8')

  it('exists, is valid bash, and refuses to run without a hostname', () => {
    expect(existsSync(ENABLE)).toBe(true)
    execFileSync('bash', ['-n', ENABLE])
    expect(text()).toMatch(/set -euo pipefail/)
    expect(text()).toMatch(/Usage: .*enable-teams\.sh <hostname>/)
  })

  it('proxies only the Teams webhook path and opens only 80 and 443', () => {
    const t = text()
    expect(t).toContain('handle /api/teams/* {')
    expect(t).toContain('reverse_proxy 127.0.0.1:3030')
    expect(t).toContain('respond 404')
    expect(t).toMatch(/ufw allow 80\/tcp/)
    expect(t).toMatch(/ufw allow 443\/tcp/)
    expect(t).not.toMatch(/ufw allow 3030/)
    expect(t).toContain('/api/teams/messages')
  })
})
