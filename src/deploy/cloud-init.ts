/**
 * Hosted-VPS user-data generation (docs/HOSTED-VPS.md).
 *
 * Pure on purpose, matching the setup wizard's plan/execute split: this module
 * validates a client spec and renders deploy/cloud-init.yaml.template plus
 * deploy/havn.service.template into finished cloud-init user-data, and
 * scripts/make-cloud-init.ts is the thin CLI shell around it. Every decision
 * (SSH toggle, Tailscale block, refusal rules) lives here, testable, with no
 * filesystem or network in sight.
 *
 * The renderer is strict where the wizard's substituteTemplate is forgiving:
 * setup blanks unknown placeholders because a half-filled CLAUDE.md is
 * annoying, but half-filled user-data provisions a broken server 40 minutes
 * from now on someone else's cloud account. Anything unfilled is a refusal.
 */

export interface ClientSpec {
  /** Client/host name, e.g. 'havn-marina'. Becomes the VPS hostname. */
  hostName: string
  /** IANA timezone for the install, e.g. 'America/Toronto'. */
  timezone: string
  /** The operator's SSH public key line (authorized_keys format). */
  sshPublicKey: string
  /** GitHub token able to read the private repo. Never logged, never in argv. */
  githubDeployToken: string
  /** When set, Tailscale is installed and inbound SSH stays closed. */
  tailscaleAuthKey?: string
  /** owner/name on GitHub. */
  gitRepo?: string
  /** Branch or tag to deploy. */
  gitRef?: string
  /** Where the app lives on the box. */
  installDir?: string
}

export const DEFAULT_GIT_REPO = 'lefebma/ai-assistant-starter'
export const DEFAULT_GIT_REF = 'main'
export const DEFAULT_INSTALL_DIR = '/home/havn/havn'

/**
 * Everything the box could be told to accept for login. Public-key line
 * shapes per sshd's authorized_keys grammar; the private-key check comes
 * first because pasting the wrong file of the pair is the likeliest mistake
 * and "does not look like a public key" would be a cruel way to report it.
 */
const SSH_KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]
const SSH_KEY_RE = new RegExp(
  `^(${SSH_KEY_TYPES.map((t) => t.replace(/\./g, '\\.')).join('|')}) [A-Za-z0-9+/]+={0,3}( [^\\r\\n]+)?$`
)

/** RFC 1123 label: what a hostname (and our file names) can safely be. */
const HOST_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The IANA zones this Node build knows. 'UTC' is unioned in because some
 * engines omit it from supportedValuesOf while accepting it everywhere else.
 */
export function knownTimezones(): string[] {
  return [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])]
}

export function validateSshPublicKey(key: string): string | null {
  const trimmed = key.trim()
  if (!trimmed) return 'sshPublicKey is empty'
  if (trimmed.includes('PRIVATE KEY')) {
    return 'sshPublicKey looks like a PRIVATE key — pass the .pub half of the pair'
  }
  if (trimmed.includes('\n')) return 'sshPublicKey must be a single authorized_keys line'
  if (!SSH_KEY_RE.test(trimmed)) {
    return `sshPublicKey does not look like an OpenSSH public key (expected e.g. 'ssh-ed25519 AAAA... comment')`
  }
  return null
}

/** Every problem with the spec, in plain English. Empty array means go. */
export function validateSpec(spec: ClientSpec, timezones: string[] = knownTimezones()): string[] {
  const problems: string[] = []

  if (!spec.hostName?.trim()) problems.push('hostName is required (e.g. havn-marina)')
  else if (!HOST_NAME_RE.test(spec.hostName.trim())) {
    problems.push(`hostName '${spec.hostName}' is not a valid hostname (lowercase letters, digits, hyphens)`)
  }

  if (!spec.timezone?.trim()) problems.push('timezone is required (e.g. America/Toronto)')
  else if (!timezones.includes(spec.timezone.trim())) {
    problems.push(`timezone '${spec.timezone}' is not a known IANA timezone`)
  }

  const keyProblem = validateSshPublicKey(spec.sshPublicKey ?? '')
  if (keyProblem) problems.push(keyProblem)

  if (!spec.githubDeployToken?.trim()) {
    problems.push('githubDeployToken is required (set GITHUB_DEPLOY_TOKEN in the environment)')
  } else if (/\s/.test(spec.githubDeployToken.trim())) {
    problems.push('githubDeployToken must not contain whitespace')
  }

  if (spec.tailscaleAuthKey !== undefined && !/^\S+$/.test(spec.tailscaleAuthKey.trim())) {
    problems.push('tailscaleAuthKey is set but empty or malformed')
  }

  const repo = spec.gitRepo ?? DEFAULT_GIT_REPO
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push(`gitRepo '${repo}' must be owner/name`)

  const ref = spec.gitRef ?? DEFAULT_GIT_REF
  if (!/^[\w./-]+$/.test(ref)) problems.push(`gitRef '${ref}' is not a plausible branch or tag name`)

  const dir = spec.installDir ?? DEFAULT_INSTALL_DIR
  if (!/^\/[\w./-]*[\w-]$/.test(dir)) {
    problems.push(`installDir '${dir}' must be an absolute path without spaces or a trailing slash`)
  }

  return problems
}

/**
 * {{KEY}} substitution, strict and indentation-aware. Multi-line values (the
 * embedded systemd unit) inherit the placeholder's leading whitespace on every
 * line, so a one-line placeholder inside a YAML block scalar expands without
 * breaking the block. Unknown placeholders are left in place and reported.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>
): { text: string; unfilled: string[] } {
  const unfilled = new Set<string>()
  const text = template.replace(/([^\S\r\n]*)\{\{([A-Z_]+)\}\}/g, (whole, indent: string, key: string) => {
    const value = vars[key]
    if (value === undefined) {
      unfilled.add(key)
      return whole
    }
    return indent + value.split('\n').join('\n' + indent)
  })
  return { text, unfilled: [...unfilled].sort() }
}

/**
 * The SSH toggle, in one place. With a Tailscale key the box keeps ZERO open
 * inbound ports and SSH rides the tailnet (`tailscale up --ssh`); without one,
 * ufw must allow OpenSSH or the operator can never log in to finish setup.
 */
export function buildVars(spec: ClientSpec): Record<string, string> {
  const hostName = spec.hostName.trim()
  const tailscaleKey = spec.tailscaleAuthKey?.trim()
  return {
    HOST_NAME: hostName,
    TIMEZONE: spec.timezone.trim(),
    SSH_PUBLIC_KEY: spec.sshPublicKey.trim(),
    GITHUB_DEPLOY_TOKEN: spec.githubDeployToken.trim(),
    GIT_REPO: spec.gitRepo?.trim() || DEFAULT_GIT_REPO,
    GIT_REF: spec.gitRef?.trim() || DEFAULT_GIT_REF,
    INSTALL_DIR: spec.installDir?.trim() || DEFAULT_INSTALL_DIR,
    UFW_SSH_CMD: tailscaleKey
      ? 'true  # inbound SSH stays closed; connect over Tailscale'
      : 'ufw allow OpenSSH',
    TAILSCALE_CMD: tailscaleKey
      ? `curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh && sh /tmp/tailscale_install.sh && rm -f /tmp/tailscale_install.sh && tailscale up --auth-key ${tailscaleKey} --ssh --hostname ${hostName}`
      : 'true  # Tailscale not used on this install',
  }
}

/**
 * The whole pipeline: validate, render the systemd unit, embed it, render the
 * user-data. Throws (never emits) on any validation problem or any placeholder
 * left unfilled in either template.
 */
export function renderCloudInit(
  cloudInitTemplate: string,
  unitTemplate: string,
  spec: ClientSpec,
  timezones: string[] = knownTimezones()
): string {
  const problems = validateSpec(spec, timezones)
  if (problems.length > 0) {
    throw new Error(`refusing to render user-data:\n  - ${problems.join('\n  - ')}`)
  }

  const vars = buildVars(spec)

  const unit = renderTemplate(unitTemplate, vars)
  if (unit.unfilled.length > 0) {
    throw new Error(`havn.service.template has unfilled placeholders: ${unit.unfilled.join(', ')}`)
  }

  const rendered = renderTemplate(cloudInitTemplate, { ...vars, SYSTEMD_UNIT: unit.text.trimEnd() })
  if (rendered.unfilled.length > 0) {
    throw new Error(`cloud-init.yaml.template has unfilled placeholders: ${rendered.unfilled.join(', ')}`)
  }

  // Belt and braces: nothing placeholder-shaped may survive into user-data.
  const leftovers = rendered.text.match(/\{\{[A-Z_]+\}\}/g)
  if (leftovers) {
    throw new Error(`rendered user-data still contains placeholders: ${[...new Set(leftovers)].join(', ')}`)
  }

  return rendered.text
}

/**
 * Per-provider create commands referencing the emitted file. Printed, never
 * executed — creating servers on someone's cloud account is a human decision.
 * No secrets here: provider auth is an env var each CLI reads on its own, and
 * the client secrets ride inside the user-data file.
 */
export function providerCommands(outFile: string, hostName: string): string {
  return `Create the server (pick one provider; nothing below is executed for you):

  # Hetzner Cloud — CAX11 (2 vCPU Ampere ARM, 4 GB), cheapest solid option; EU regions only
  # auth: export HCLOUD_TOKEN first (from your password manager, not the shell history)
  hcloud server create --name ${hostName} --type cax11 --image ubuntu-24.04 \\
    --location nbg1 --ssh-key <your-hcloud-ssh-key-name> \\
    --user-data-from-file ${outFile}

  # DigitalOcean — Toronto region
  # auth: doctl auth init (reads DIGITALOCEAN_ACCESS_TOKEN from the environment)
  doctl compute droplet create ${hostName} --region tor1 --size s-1vcpu-2gb \\
    --image ubuntu-24-04-x64 --ssh-keys <your-do-key-id> \\
    --user-data-file ${outFile}

  # Vultr — Toronto region
  # auth: export VULTR_API_KEY first
  vultr-cli instance create --region yto --plan vc2-1c-2gb \\
    --os <ubuntu-24.04-os-id> --label ${hostName} --host ${hostName} \\
    --userdata "$(cat ${outFile})"
  #   (find the OS id with: vultr-cli os list | grep 24.04)

  # OVH — Beauharnois (BHS) for Canadian data residency
  #   No one-line CLI for this: in the OVH manager create a Public Cloud
  #   instance in BHS, pick Ubuntu 24.04, and paste the contents of
  #   ${outFile} into the cloud-init / post-installation script box.

The rendered file contains the deploy token and any Tailscale key.
Delete it once the server exists: rm ${outFile}`
}
