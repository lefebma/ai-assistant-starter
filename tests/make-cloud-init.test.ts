import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_GIT_REPO,
  buildVars,
  knownTimezones,
  providerCommands,
  renderCloudInit,
  renderTemplate,
  validateSpec,
  validateSshPublicKey,
  type ClientSpec,
} from '../src/deploy/cloud-init.js'
import { parseArgs, resolveSshKey } from '../scripts/make-cloud-init.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = join(ROOT, 'deploy')

const cloudInitTemplate = readFileSync(join(DEPLOY, 'cloud-init.yaml.template'), 'utf-8')
const unitTemplate = readFileSync(join(DEPLOY, 'havn.service.template'), 'utf-8')

/** A key that passes shape validation without being anyone's real key. */
const FAKE_ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleEx0 op@laptop'

const SPEC: ClientSpec = {
  hostName: 'havn-testclient',
  timezone: 'America/Toronto',
  sshPublicKey: FAKE_ED25519,
  githubDeployToken: 'test-deploy-token-not-real',
}

describe('validateSpec', () => {
  it('accepts a complete spec', () => {
    expect(validateSpec(SPEC)).toEqual([])
  })

  it('refuses an empty deploy token', () => {
    const problems = validateSpec({ ...SPEC, githubDeployToken: '' })
    expect(problems.join('\n')).toContain('githubDeployToken')
  })

  it('refuses an unknown timezone', () => {
    const problems = validateSpec({ ...SPEC, timezone: 'Mars/OlympusMons' })
    expect(problems.join('\n')).toContain('Mars/OlympusMons')
  })

  it('checks the timezone against the real IANA list', () => {
    expect(knownTimezones()).toContain('America/Toronto')
    expect(knownTimezones()).toContain('UTC')
  })

  it('refuses a hostname with dots or uppercase', () => {
    expect(validateSpec({ ...SPEC, hostName: 'Havn.Client' }).join('\n')).toContain('hostname')
  })

  it('reports every problem at once, not just the first', () => {
    const problems = validateSpec({ ...SPEC, hostName: '', timezone: '', githubDeployToken: '' })
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('validateSshPublicKey', () => {
  it('accepts ed25519 and rsa public keys, with or without comment', () => {
    expect(validateSshPublicKey(FAKE_ED25519)).toBeNull()
    expect(validateSshPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB')).toBeNull()
  })

  it('names the mistake when handed a private key', () => {
    const err = validateSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')
    expect(err).toContain('PRIVATE')
  })

  it('rejects things that are not keys at all', () => {
    expect(validateSshPublicKey('not-a-key')).not.toBeNull()
    expect(validateSshPublicKey('')).not.toBeNull()
  })
})

describe('renderTemplate', () => {
  it('substitutes and reports nothing unfilled when all vars are present', () => {
    const { text, unfilled } = renderTemplate('a {{X}} b', { X: '1' })
    expect(text).toBe('a 1 b')
    expect(unfilled).toEqual([])
  })

  it('leaves unknown placeholders in place and reports them', () => {
    const { text, unfilled } = renderTemplate('a {{NOT_A_REAL_VAR}} b', {})
    expect(text).toContain('{{NOT_A_REAL_VAR}}')
    expect(unfilled).toEqual(['NOT_A_REAL_VAR'])
  })

  it('indents multi-line values to the placeholder, preserving YAML blocks', () => {
    const { text } = renderTemplate('    {{UNIT}}', { UNIT: '[Unit]\nDescription=x' })
    expect(text).toBe('    [Unit]\n    Description=x')
  })
})

describe('renderCloudInit', () => {
  const rendered = renderCloudInit(cloudInitTemplate, unitTemplate, SPEC)

  it('fills every placeholder', () => {
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('carries the client identity', () => {
    expect(rendered).toContain('hostname: havn-testclient')
    expect(rendered).toContain('timezone: America/Toronto')
    expect(rendered).toContain(FAKE_ED25519)
  })

  it('denies all inbound traffic by default', () => {
    expect(rendered).toContain('ufw default deny incoming')
    expect(rendered).toContain('ufw default allow outgoing')
    expect(rendered).toContain('ufw --force enable')
  })

  it('allows SSH only when Tailscale is not used', () => {
    expect(rendered).toContain('ufw allow OpenSSH')
    expect(rendered).not.toContain('tailscale up')
  })

  it('closes inbound SSH and joins the tailnet when a Tailscale key is given', () => {
    const ts = renderCloudInit(cloudInitTemplate, unitTemplate, {
      ...SPEC,
      tailscaleAuthKey: 'tskey-test-not-real',
    })
    expect(ts).not.toContain('ufw allow OpenSSH')
    expect(ts).toContain('inbound SSH stays closed')
    expect(ts).toContain('tailscale up --auth-key tskey-test-not-real --ssh --hostname havn-testclient')
  })

  it('embeds the systemd unit, indented as a YAML block, disabled by default', () => {
    expect(rendered).toContain('      [Unit]')
    expect(rendered).toContain('      User=havn')
    // always, never on-failure: voluntary clean exits (watchdog, /update,
    // agent-initiated restarts) must respawn too - pilot finding, card #99.
    expect(rendered).toContain('      Restart=always')
    expect(rendered).toContain('      RestartSec=70')
    expect(rendered).toContain('      StartLimitIntervalSec=0')
    expect(rendered).not.toContain('Restart=on-failure')
    expect(rendered).toContain('      EnvironmentFile=-/home/havn/havn/.env')
    // Registered but never enabled: first-run setup is interactive.
    expect(rendered).toContain('systemctl daemon-reload')
    expect(rendered).not.toMatch(/systemctl (enable|start) havn/)
  })

  it('clones with the deploy token, then scrubs it from the git remote', () => {
    expect(rendered).toContain(`x-access-token:test-deploy-token-not-real@github.com/${DEFAULT_GIT_REPO}.git`)
    expect(rendered).toContain(`remote set-url origin "https://github.com/${DEFAULT_GIT_REPO}.git"`)
  })

  it('builds as the havn user and leaves a ready marker', () => {
    expect(rendered).toContain("npm ci --no-audit --no-fund && npm run build'")
    expect(rendered).toContain('/etc/update-motd.d/99-havn')
    expect(rendered).toContain('npm run setup')
  })

  it('keeps unattended-upgrades on', () => {
    expect(rendered).toContain('unattended-upgrades')
    expect(rendered).toContain('APT::Periodic::Unattended-Upgrade "1";')
  })

  it('refuses to render with a missing value rather than emitting a broken file', () => {
    expect(() => renderCloudInit(cloudInitTemplate, unitTemplate, { ...SPEC, sshPublicKey: '' })).toThrow(
      /refusing to render/
    )
    expect(() => renderCloudInit(cloudInitTemplate, unitTemplate, { ...SPEC, githubDeployToken: ' ' })).toThrow(
      /githubDeployToken/
    )
  })

  it('refuses when a template placeholder has no value at all', () => {
    expect(() => renderCloudInit('#cloud-config\nx: {{NOT_A_REAL_VAR}}', unitTemplate, SPEC)).toThrow(
      /NOT_A_REAL_VAR/
    )
  })
})

describe('buildVars SSH toggle', () => {
  it('is the single source of the ufw decision', () => {
    expect(buildVars(SPEC).UFW_SSH_CMD).toBe('ufw allow OpenSSH')
    expect(buildVars({ ...SPEC, tailscaleAuthKey: 'tskey-x' }).UFW_SSH_CMD).toContain('stays closed')
  })
})

describe('provider commands', () => {
  const out = providerCommands('deploy/rendered/havn-testclient.user-data.yaml', 'havn-testclient')

  it('covers all four providers and references the emitted file', () => {
    for (const needle of ['hcloud server create', 'doctl compute droplet create', 'vultr-cli instance create', 'OVH']) {
      expect(out).toContain(needle)
    }
    expect(out).toContain('deploy/rendered/havn-testclient.user-data.yaml')
  })

  it('points provider auth at env vars instead of inline secrets', () => {
    expect(out).toContain('HCLOUD_TOKEN')
    expect(out).toContain('VULTR_API_KEY')
    expect(out).not.toContain('test-deploy-token-not-real')
  })
})

describe('shipped templates', () => {
  it('contain no real-looking secrets', () => {
    const secretShapes =
      /(sk-ant-[A-Za-z0-9_-]{8}|ghp_[A-Za-z0-9]{8}|github_pat_[A-Za-z0-9_]{8}|tskey-(auth|api)-[A-Za-z0-9]{4}|xox[bap]-[0-9]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{20})/
    for (const name of readdirSync(DEPLOY).filter((n) => n.endsWith('.template'))) {
      const text = readFileSync(join(DEPLOY, name), 'utf-8')
      expect(secretShapes.test(text), `${name} looks like it ships a secret`).toBe(false)
    }
  })

  it('every credential is a placeholder, not a value', () => {
    expect(cloudInitTemplate).toContain('{{GITHUB_DEPLOY_TOKEN}}')
    expect(cloudInitTemplate).toContain('{{SSH_PUBLIC_KEY}}')
  })

  // Pilot findings from the first real Hetzner provision (card #99):

  it('extracts gog by locating the binary, not by naming a tar member', () => {
    // Release tarballs prefix members with ./ (./gog); asking tar for the bare
    // member name aborts the whole provision under set -e.
    expect(cloudInitTemplate).not.toMatch(/tar -xzf \S+ -C \S+ gog\b/)
    expect(cloudInitTemplate).toContain('find /tmp/gogcli-extract -type f -name gog')
  })

  it('clears the service account expiry before the first sudo -u switch', () => {
    // Some images leave the cloud-init-created account password-expired and
    // PAM then refuses sudo -u havn.
    const chageAt = cloudInitTemplate.indexOf('chage -d')
    const firstSwitchAt = cloudInitTemplate.indexOf('sudo -u havn')
    expect(chageAt).toBeGreaterThan(-1)
    expect(firstSwitchAt).toBeGreaterThan(-1)
    expect(chageAt).toBeLessThan(firstSwitchAt)
  })
})

describe('CLI shell', () => {
  it('parses flags into a spec, reading the ssh key from a file when given a path', () => {
    const opts = parseArgs(['--name', 'havn-x', '--timezone', 'UTC', '--ssh-key', '/tmp/nonexistent-for-test'])
    expect(opts.hostName).toBe('havn-x')
    expect(opts.timezone).toBe('UTC')
    const key = resolveSshKey(
      '/some/key.pub',
      () => `${FAKE_ED25519}\n`,
      () => true
    )
    expect(key).toBe(FAKE_ED25519)
  })

  it('passes a literal key through untouched', () => {
    expect(
      resolveSshKey(
        FAKE_ED25519,
        () => {
          throw new Error('must not read a file')
        },
        () => {
          throw new Error('must not stat')
        }
      )
    ).toBe(FAKE_ED25519)
  })

  it('rejects unknown flags loudly', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
  })
})
