import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeJoinIO } from '../src/workspace/io.js'

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os')
  return {
    ...actual,
    homedir: vi.fn(() => process.env.HOME ?? '/home/test'),
  }
})

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  vi.clearAllMocks()
})

describe('workspace ensureKnownHost', () => {
  it('fetches GitHub host keys and writes to known_hosts with mode 0600', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'havn-known-hosts-'))
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    vi.stubEnv('HOME', tmpDir)

    const fetchStub = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/meta') {
        return {
          ok: true,
          json: async () => ({ ssh_keys: ['ssh-ed25519 AAAAtest', 'ssh-rsa AAAAtest2'] }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    global.fetch = fetchStub

    const io = makeJoinIO()
    const result = await io.ensureKnownHost('github.com')

    expect(result.ok).toBe(true)
    expect(fetchStub).toHaveBeenCalledWith('https://api.github.com/meta', {
      signal: expect.any(AbortSignal),
    })

    const knownHostsPath = join(tmpDir, '.ssh', 'known_hosts')
    const content = readFileSync(knownHostsPath, 'utf-8')
    expect(content).toContain('github.com ssh-ed25519 AAAAtest')
    expect(content).toContain('github.com ssh-rsa AAAAtest2')

    const stat = statSync(knownHostsPath)
    expect((stat.mode & 0o777).toString(8)).toBe('600')
  })

  it('returns timeout error when GitHub fetch times out', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'havn-known-hosts-'))
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    vi.stubEnv('HOME', tmpDir)

    const timeoutError = new DOMException('The operation was aborted', 'AbortError')
    const fetchStub = vi.fn(async () => {
      throw timeoutError
    })
    global.fetch = fetchStub

    const io = makeJoinIO()
    const result = await io.ensureKnownHost('github.com')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('timed out fetching GitHub host keys')
  })
})
