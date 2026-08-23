/**
 * Planning half of the Teams registration: what to name things, where the
 * messaging endpoint lives. No I/O; scripts/teams-register.ts drives `az`
 * from this.
 *
 * Registrations are always single-tenant: Azure stopped accepting new
 * multi-tenant bots (`InvalidBotCreationData: Multitenant bot creation is
 * deprecated`, Aug 2026). `tenant` picks which tenant; when it is absent the
 * script uses the tenant `az` is signed in to.
 */
import { isValidHostname } from './teams-edge.js'

export interface RegisterOptions {
  name: string
  hostname: string
  tenant?: string
  resourceGroup: string
  location: string
  rotateSecret: boolean
}

export interface RegistrationPlan {
  displayName: string
  botName: string
  endpoint: string
  audience: 'AzureADMyOrg'
  appType: 'SingleTenant'
  groupLocation: string
}

export const REGISTER_USAGE =
  'Usage: npm run teams-register -- <name> <hostname> [--tenant <id>] [--resource-group <rg>] [--location <loc>] [--rotate-secret]'

const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/

export function parseRegisterArgs(argv: string[]): RegisterOptions {
  const [name, hostname, ...rest] = argv
  if (!name || !hostname) throw new Error(`name and hostname are required\n${REGISTER_USAGE}`)
  if (!NAME.test(name)) throw new Error(`name must be lowercase letters, digits, and dashes (used in resource names): ${name}\n${REGISTER_USAGE}`)
  if (!isValidHostname(hostname)) throw new Error(`Not a valid hostname: ${hostname}\n${REGISTER_USAGE}`)
  const opts: RegisterOptions = { name, hostname, tenant: undefined, resourceGroup: 'havn-bots', location: 'global', rotateSecret: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value\n${REGISTER_USAGE}`)
      return v
    }
    if (arg === '--tenant') opts.tenant = value()
    else if (arg === '--resource-group') opts.resourceGroup = value()
    else if (arg === '--location') opts.location = value()
    else if (arg === '--rotate-secret') opts.rotateSecret = true
    else throw new Error(`Unknown option: ${arg}\n${REGISTER_USAGE}`)
  }
  return opts
}

export function registrationPlan(opts: RegisterOptions): RegistrationPlan {
  return {
    displayName: `Havn - ${opts.name}`,
    botName: `havn-${opts.name}`,
    endpoint: `https://${opts.hostname}/api/teams/messages`,
    audience: 'AzureADMyOrg',
    appType: 'SingleTenant',
    groupLocation: opts.location === 'global' ? 'eastus' : opts.location,
  }
}

/**
 * `az ad app list --display-name X --query '[].appId' -o tsv` prints one id
 * per line. None means create; one means reuse; more than one means a human
 * has to pick, because guessing would silently bind the bot to the wrong app.
 */
export function pickExistingAppId(tsv: string, displayName: string): string | null {
  const ids = tsv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (ids.length === 0) return null
  if (ids.length === 1) return ids[0]
  throw new Error(
    `${ids.length} app registrations are named "${displayName}" (${ids.join(', ')}). ` +
      'Delete the extras in Entra (App registrations) or rename them, then re-run.'
  )
}
