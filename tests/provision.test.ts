import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  addressFor,
  clientEmail,
  extractSetupLink,
  hostNameFor,
  provision,
  validateProvisionSpec,
  type ProvisionDeps,
  type ProvisionSpec,
  type SshResult,
} from '../src/deploy/provision.js'
import { parseProvisionArgs } from '../scripts/hosted/provision.js'

const ROOT = resolve(__dirname, '..')
const templates = {
  cloudInit: readFileSync(resolve(ROOT, 'deploy/cloud-init.yaml.template'), 'utf-8'),
  unit: readFileSync(resolve(ROOT, 'deploy/havn.service.template'), 'utf-8'),
}
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl marc@mini'
const TOKEN = 'A'.repeat(43)

const spec = (over: Partial<ProvisionSpec> = {}): ProvisionSpec => ({
  client: 'leif',
  country: 'us',
  timezone: 'America/New_York',
  sshPublicKey: KEY,
  ...over,
})

interface Call {
  method: string
  url: string
  body?: any
}

/** A Vultr + Cloudflare + box that behaves, with knobs for the failure cases. */
function world(opts: {
  existingInstance?: boolean
  existingDns?: boolean
  bootStatus?: 'done' | 'error'
  notProvisioned?: boolean
  enableOutput?: string
  enableCode?: number
} = {}) {
  const calls: Call[] = []
  const sshCalls: string[] = []
  const sshUsers: string[] = []
  let polls = 0
  let clock = 0
  let sshTries = 0

  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (url.startsWith('https://api.vultr.com/v2/instances?label=')) {
      return json(200, { instances: opts.existingInstance ? [{ id: 'old', main_ip: '1.2.3.4' }] : [] })
    }
    if (url === 'https://api.vultr.com/v2/instances' && method === 'POST') {
      return json(202, { instance: { id: 'inst-1', status: 'pending', main_ip: '0.0.0.0' } })
    }
    if (url === 'https://api.vultr.com/v2/instances/inst-1') {
      polls++
      return json(200, { instance: polls < 3 ? { status: 'pending', main_ip: '0.0.0.0' } : { status: 'active', main_ip: '45.77.1.2' } })
    }
    if (url.endsWith('/backup-schedule')) return new Response(null, { status: 204 })
    if (url.includes('/dns_records?name=')) return json(200, { success: true, result: opts.existingDns ? [{ id: 'x' }] : [] })
    if (url.endsWith('/dns_records') && method === 'POST') return json(200, { success: true, result: { id: 'rec' } })
    return json(404, { error: 'unexpected ' + url })
  }) as unknown as typeof fetch

  const ssh = async (host: string, command: string, user?: string): Promise<SshResult> => {
    sshCalls.push(`${host} ${command}`)
    sshUsers.push(user ?? 'havn')
    if (command.startsWith('cloud-init status')) {
      sshTries++
      if (sshTries === 1) return { code: 255, stdout: '', stderr: 'Connection refused' }
      if (sshTries === 2) return { code: 0, stdout: 'status: running\n', stderr: '' }
      const status = opts.bootStatus ?? 'done'
      return { code: status === 'error' ? 1 : 0, stdout: `status: ${status}\n${opts.notProvisioned ? '' : 'HAVN_READY\n'}`, stderr: '' }
    }
    if (command.includes('enable-setup.js')) {
      return {
        code: opts.enableCode ?? 0,
        stdout: opts.enableOutput ?? `Web setup is live. Send the client this link:\n\n  https://leif.gethavn.ai/setup?token=${TOKEN}\n`,
        stderr: '',
      }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }

  const log: string[] = []
  const deps: ProvisionDeps = {
    fetch: fetchFn,
    vultrApiKey: 'vk',
    cloudflareToken: 'ct',
    cloudflareZoneId: 'zone1',
    ssh,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    log: (m) => log.push(m),
    templates,
  }
  return { deps, calls, sshCalls, sshUsers, log }
}

describe('naming and validation', () => {
  it('derives host and address from the client name', () => {
    expect(hostNameFor('leif')).toBe('havn-leif')
    expect(addressFor('leif')).toBe('leif.gethavn.ai')
  })

  it('refuses bad, reserved and unknown-country input', () => {
    expect(validateProvisionSpec(spec({ client: 'Leif B' }))[0]).toMatch(/lowercase/)
    expect(validateProvisionSpec(spec({ client: 'staging' }))[0]).toMatch(/reserved/)
    expect(validateProvisionSpec(spec({ client: 'www' }))[0]).toMatch(/reserved/)
    expect(validateProvisionSpec(spec({ country: 'uk' as never }))[0]).toMatch(/us or ca/)
    expect(validateProvisionSpec(spec({ client: 'smith-law' }))).toEqual([])
  })
})

describe('provision', () => {
  it('creates the box, backups, DNS, waits for boot, and returns the link', async () => {
    const w = world()
    const r = await provision(spec(), w.deps)
    expect(r).toEqual({
      instanceId: 'inst-1',
      hostName: 'havn-leif',
      ip: '45.77.1.2',
      region: 'ewr',
      address: 'leif.gethavn.ai',
      link: `https://leif.gethavn.ai/setup?token=${TOKEN}`,
    })

    const create = w.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/instances'))!
    expect(create.body).toMatchObject({ region: 'ewr', plan: 'vc2-1c-2gb', os_id: 2284, label: 'havn-leif', backups: 'enabled' })
    const userData = Buffer.from(create.body.user_data, 'base64').toString('utf-8')
    expect(userData).toContain('hostname: havn-leif')
    expect(userData).toContain('PermitRootLogin no')
    expect(userData).toContain('usermod -L -e 1 linuxuser')

    expect(w.calls.find((c) => c.url.endsWith('/backup-schedule'))!.body).toEqual({ type: 'daily', hour: 7 })
    const dns = w.calls.find((c) => c.method === 'POST' && c.url.endsWith('/dns_records'))!
    expect(dns.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records')
    expect(dns.body).toMatchObject({ type: 'A', name: 'leif.gethavn.ai', content: '45.77.1.2', proxied: false })

    // Waited through ssh-refused and running before enabling setup.
    expect(w.sshCalls.filter((c) => c.includes('cloud-init status'))).toHaveLength(3)
    expect(w.sshCalls.at(-1)).toBe('45.77.1.2 cd /home/havn/havn && sudo node dist/scripts/hosted/enable-setup.js leif.gethavn.ai')
    // havn has no general sudo (card #196): the root step logs in as havn-admin, polling as havn.
    expect(w.sshUsers.at(-1)).toBe('havn-admin')
    expect(w.sshUsers.slice(0, -1).every((u) => u === 'havn')).toBe(true)
  })

  it('puts Canadian clients in Toronto', async () => {
    const w = world()
    const r = await provision(spec({ country: 'ca', timezone: 'America/Toronto' }), w.deps)
    expect(r.region).toBe('yto')
  })

  it('spends nothing when the name is taken on Vultr or in DNS', async () => {
    for (const opt of [{ existingInstance: true }, { existingDns: true }]) {
      const w = world(opt)
      await expect(provision(spec(), w.deps)).rejects.toThrow(/already/)
      expect(w.calls.some((c) => c.method === 'POST')).toBe(false)
    }
  })

  it('spends nothing on a bad name or key', async () => {
    const w = world()
    await expect(provision(spec({ client: 'www' }), w.deps)).rejects.toThrow(/reserved/)
    await expect(provision(spec({ sshPublicKey: 'nope' }), w.deps)).rejects.toThrow()
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('names the billing server when first boot fails', async () => {
    const w = world({ bootStatus: 'error' })
    await expect(provision(spec(), w.deps)).rejects.toThrow(/first boot failed[\s\S]*inst-1/)
  })

  it('treats a finished boot without the provisioned marker as a failure', async () => {
    const w = world({ notProvisioned: true })
    await expect(provision(spec(), w.deps)).rejects.toThrow(/not marked provisioned/)
  })

  it('fails clearly when enable-setup prints no link', async () => {
    const w = world({ enableCode: 1, enableOutput: 'Refusing: .env exists' })
    await expect(provision(spec(), w.deps)).rejects.toThrow(/did not produce a link[\s\S]*Refusing[\s\S]*inst-1/)
  })
})

describe('link and email', () => {
  it('only accepts a link for this address', () => {
    const out = `x\n  https://evil.example/setup?token=${TOKEN}\n  https://leif.gethavn.ai/setup?token=${TOKEN}\n`
    expect(extractSetupLink(out, 'leif.gethavn.ai')).toBe(`https://leif.gethavn.ai/setup?token=${TOKEN}`)
    expect(extractSetupLink('nothing here', 'leif.gethavn.ai')).toBeNull()
    expect(extractSetupLink(`https://leifXgethavn.ai/setup?token=${TOKEN}`, 'leif.gethavn.ai')).toBeNull()
  })

  it('writes a plain email with the link and no em dashes', () => {
    const text = clientEmail({ clientName: 'Leif', link: 'https://leif.gethavn.ai/setup?token=abc' })
    expect(text).toContain('Hi Leif,')
    expect(text).toContain('https://leif.gethavn.ai/setup?token=abc')
    expect(text).toMatch(/48 hours/)
    expect(text).not.toContain('—')
  })
})

describe('CLI arguments', () => {
  it('defaults the timezone by country and lowercases the client', () => {
    const us = parseProvisionArgs(['--client', 'Leif', '--country', 'us', '--ssh-key', KEY])
    expect(us.spec).toMatchObject({ client: 'leif', country: 'us', timezone: 'America/New_York' })
    const ca = parseProvisionArgs(['--client', 'smith', '--country', 'ca', '--ssh-key', KEY, '--name', 'Jo', '--dry-run'])
    expect(ca.spec.timezone).toBe('America/Toronto')
    expect(ca.name).toBe('Jo')
    expect(ca.dryRun).toBe(true)
  })

  it('requires client, country and key', () => {
    expect(() => parseProvisionArgs(['--client', 'leif', '--country', 'us'])).toThrow(/--ssh-key is required/)
    expect(() => parseProvisionArgs(['--bogus'])).toThrow(/Unknown option/)
  })
})
