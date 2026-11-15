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
  checkScript,
  type RelayAdmin,
} from '../scripts/hosted/relay-box.js'
import { CAN_RUN_BOX_SCRIPTS, fakeBox } from './box-script-fixture.js'

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

  it.skipIf(!CAN_RUN_BOX_SCRIPTS)('writes the three /connect secrets to the vault and never creates .env, so web setup still runs', () => {
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

  it.skipIf(!CAN_RUN_BOX_SCRIPTS)('leaves an existing .env alone', () => {
    const box = fakeBox()
    try {
      writeFileSync(join(box.dir, '.env'), 'TZ=America/Toronto\n')
      expect(box.run(relayScript(DEFAULT_RELAY_URL, 'havn-test', KEY)).code).toBe(0)
      expect(box.env()).toBe('TZ=America/Toronto\n')
    } finally {
      box.cleanup()
    }
  })

  it.skipIf(!CAN_RUN_BOX_SCRIPTS)('the check passes on an install and reports the edge', () => {
    const box = fakeBox()
    try {
      const caddy = join(box.dir, 'Caddyfile')
      expect(box.run(checkScript(box.dir, caddy)).stdout).toContain('EDGE_UNKNOWN')
      writeFileSync(caddy, 'x {\n\thandle @setup {\n\t}\n}\n')
      expect(box.run(checkScript(box.dir, caddy)).stdout).toContain('EDGE_MISSING')
      writeFileSync(caddy, 'x {\n\thandle /connect/handoff {\n\t}\n}\n')
      const r = box.run(checkScript(box.dir, caddy))
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toContain('EDGE_OK')
      expect(box.run(checkScript(join(box.dir, 'missing'), caddy)).code).not.toBe(0)
    } finally {
      box.cleanup()
    }
  })
})

describe('connectRelayBox', () => {
  /** A box whose check and write answer as told, recording what ran. */
  function boxRunner(check: { code: number; stdout?: string }, write = { code: 0 }) {
    const ran: string[] = []
    const run = async (_host: string, s: string) => {
      const isCheck = s.includes('vault-cli.js list')
      ran.push(isCheck ? 'check' : 'write')
      return isCheck ? check : write
    }
    return { ran, run }
  }

  it('checks the box, registers, then writes, and reports the edge', async () => {
    const { a, calls } = relay()
    const b = boxRunner({ code: 0, stdout: 'EDGE_MISSING\n' })
    const reg = await connectRelayBox(a, 'havn-leif', '45.77.1.2', 'leif.gethavn.ai', 'L', b.run)
    expect(b.ran).toEqual(['check', 'write'])
    expect(calls.map((c) => c.method)).toEqual(['POST'])
    expect(reg.edge).toBe('missing')
    expect((await connectRelayBox(a, 'havn-leif', 'h', 'leif.gethavn.ai', 'L', boxRunner({ code: 0, stdout: 'EDGE_OK' }).run)).edge).toBe('ok')
    expect((await connectRelayBox(a, 'havn-leif', 'h', 'leif.gethavn.ai', 'L', boxRunner({ code: 0 }).run)).edge).toBe('unknown')
  })

  it('never registers a box it cannot reach, so a connected box keeps its key', async () => {
    const { a, calls } = relay()
    const b = boxRunner({ code: 255 })
    await expect(connectRelayBox(a, 'havn-leif', '45.77.1.2', 'leif.gethavn.ai', 'L', b.run)).rejects.toThrow(/Nothing was registered/)
    expect(calls).toEqual([])
    expect(b.ran).toEqual(['check'])
  })

  it('a failed write on an existing box keeps the registration and says /connect stops until a re-run', async () => {
    const { a, calls } = relay()
    await expect(connectRelayBox(a, 'havn-leif', 'h', 'leif.gethavn.ai', 'L', boxRunner({ code: 0 }, { code: 1 }).run))
      .rejects.toThrow(/re-run register and restart/)
    expect(calls.map((c) => c.method)).toEqual(['POST'])
  })

  it('a failed write while provisioning removes the registration', async () => {
    const { a, calls } = relay()
    await expect(connectRelayBox(a, 'havn-leif', 'h', 'leif.gethavn.ai', 'L', boxRunner({ code: 0 }, { code: 1 }).run, { removeOnFailure: true }))
      .rejects.toThrow(/registration was removed/)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://connect.example.com/admin/boxes/havn-leif',
      'DELETE https://connect.example.com/admin/boxes/havn-leif',
    ])
  })
})
