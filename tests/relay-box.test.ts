import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanRelayLabel,
  connectRelayBox,
  defaultLabel,
  DEFAULT_RELAY_URL,
  registerBox,
  relayAdminFromEnv,
  relayScript,
  type RelayAdmin,
} from '../scripts/hosted/relay-box.js'
import { fakeBox } from './box-script-fixture.js'

const KEY = 'k'.repeat(43)

function relay(status = 200, answer: unknown = { box: 'havn-leif', origin: 'https://leif.gethavn.ai', label: 'Havn assistant for Leif', handoffKey: KEY }) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = []
  const a: RelayAdmin = {
    url: 'https://connect.example.com/',
    adminToken: 'admin-secret',
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(answer), { status })
    }) as unknown as typeof fetch,
  }
  return { a, calls }
}

describe('relay box registration (card #216)', () => {
  it('registers the box at its https origin with the admin token', async () => {
    const { a, calls } = relay()
    const r = await registerBox(a, 'havn-leif', 'leif.gethavn.ai', 'Havn assistant for Leif')
    expect(r.handoffKey).toBe(KEY)
    expect(calls).toEqual([{
      method: 'POST',
      url: 'https://connect.example.com/admin/boxes/havn-leif',
      auth: 'Bearer admin-secret',
      body: { origin: 'https://leif.gethavn.ai', label: 'Havn assistant for Leif' },
    }])
  })

  it('refuses bad input before calling the relay', async () => {
    const { a, calls } = relay()
    await expect(registerBox(a, 'Havn_Leif', 'leif.gethavn.ai', 'x')).rejects.toThrow(/Bad box name/)
    await expect(registerBox(a, 'havn-leif', 'https://leif.gethavn.ai', 'x')).rejects.toThrow(/hostname/)
    await expect(registerBox(a, 'havn-leif', 'leif.gethavn.ai', 'Sam & Co')).rejects.toThrow(/label/)
    await expect(registerBox(a, 'havn-leif', 'leif.gethavn.ai', '   ')).rejects.toThrow(/label/)
    expect(calls).toEqual([])
  })

  it('says plainly when the relay refuses or answers without a key', async () => {
    await expect(registerBox(relay(401, { error: 'unauthorized' }).a, 'havn-leif', 'leif.gethavn.ai', 'L')).rejects.toThrow(/refused \(401\)/)
    await expect(registerBox(relay(200, { box: 'havn-leif' }).a, 'havn-leif', 'leif.gethavn.ai', 'L')).rejects.toThrow(/without a hand-off key/)
  })

  it('makes a label the relay accepts from any client name', () => {
    expect(defaultLabel('Leif', 'leif')).toBe('Havn assistant for Leif')
    expect(defaultLabel('', 'smith-law')).toBe('Havn assistant (smith-law)')
    expect(defaultLabel('<Sam> & "Jo"', 'sam')).toBe('Havn assistant for Sam  Jo')
    expect(cleanRelayLabel(defaultLabel('x'.repeat(80), 'x'))).not.toBeNull()
    expect(cleanRelayLabel('Sam\nJo')).toBeNull()
  })

  it('takes the admin token from the environment, with the gethavn.ai relay by default', () => {
    expect(relayAdminFromEnv({})).toBeNull()
    expect(relayAdminFromEnv({ HAVN_CONNECT_ADMIN_TOKEN: ' t ' })).toEqual({ url: DEFAULT_RELAY_URL, adminToken: 't' })
    expect(relayAdminFromEnv({ HAVN_CONNECT_ADMIN_TOKEN: 't', HAVN_CONNECT_URL: 'https://r.example' })?.url).toBe('https://r.example')
    expect(() => relayAdminFromEnv({ HAVN_CONNECT_ADMIN_TOKEN: 't', HAVN_CONNECT_URL: 'http://r.example' })).toThrow(/https/)
  })
})

describe('relay secrets on the box', () => {
  it('never puts the hand-off key in the script text', () => {
    const s = relayScript(DEFAULT_RELAY_URL, 'havn-leif', KEY)
    expect(s).not.toContain(KEY)
    expect(s).not.toContain('.env')
  })

  it('writes the three /connect secrets to the vault and never creates .env, so web setup still runs', () => {
    const box = fakeBox()
    try {
      const r = box.run(relayScript('https://connect.gethavn.ai/', 'havn-leif', KEY))
      expect(r.code, r.stderr).toBe(0)
      expect(box.vault()).toEqual({ CONNECT_RELAY_URL: 'https://connect.gethavn.ai', CONNECT_BOX_ID: 'havn-leif', CONNECT_HANDOFF_KEY: KEY })
      expect(box.env()).toBeNull()
    } finally {
      box.cleanup()
    }
  })

  it('leaves an existing .env alone', () => {
    const box = fakeBox()
    try {
      writeFileSync(join(box.dir, '.env'), 'TZ=America/Toronto\n')
      expect(box.run(relayScript(DEFAULT_RELAY_URL, 'havn-test', KEY)).code).toBe(0)
      expect(box.env()).toBe('TZ=America/Toronto\n')
    } finally {
      box.cleanup()
    }
  })

  it('connectRelayBox registers, then writes; a failed write says the key is unused', async () => {
    const { a } = relay()
    const scripts: string[] = []
    const reg = await connectRelayBox(a, 'havn-leif', '45.77.1.2', 'leif.gethavn.ai', 'L', async (host, s) => {
      scripts.push(`${host}:${s.includes('CONNECT_HANDOFF_KEY')}`)
      return { code: 0 }
    })
    expect(reg.box).toBe('havn-leif')
    expect(scripts).toEqual(['45.77.1.2:true'])
    await expect(connectRelayBox(a, 'havn-leif', '45.77.1.2', 'leif.gethavn.ai', 'L', async () => ({ code: 255 })))
      .rejects.toThrow(/re-run register/)
  })
})
