/**
 * Register one Azure Bot + Entra app for one Havn install and enable the Teams
 * channel. Needs the Azure CLI, signed in (`az login`) as someone who can
 * create app registrations and Azure Bot resources in the subscription az is
 * pointed at.
 *
 *   npm run teams-register -- <name> <hostname> [--tenant <id>] [--resource-group havn-bots]
 *                               [--location global] [--rotate-secret]
 *
 * Always single-tenant (Azure no longer creates multi-tenant bots): the app
 * installs in the tenant it is registered in. Without --tenant that is the
 * tenant az is signed in to; a firm that wants the bot in its own tenant signs
 * in there, or passes --tenant with an account that can create there.
 * Idempotent: re-running finds the existing app and bot and prints the ids
 * again; the secret is minted only the first time or with --rotate-secret,
 * and is printed once, to stdout, never passed on a command line. Every az
 * call is execFileSync with an argument array: no shell, nothing interpolated.
 */
import { execFileSync } from 'node:child_process'
import { parseRegisterArgs, registrationPlan, pickExistingAppId, REGISTER_USAGE } from '../src/deploy/teams-register.js'

function az(args: string[]): string {
  return execFileSync('az', [...args, '-o', 'tsv'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function azOk(args: string[]): boolean {
  try {
    execFileSync('az', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function note(message: string): void {
  console.error(message) // stderr: stdout is reserved for the .env lines
}

function main(): void {
  let opts
  try {
    opts = parseRegisterArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  }
  if (!azOk(['--version'])) {
    console.error('az CLI not found. Install it from https://aka.ms/azure-cli and run: az login')
    process.exit(1)
  }
  if (!azOk(['account', 'show'])) {
    console.error('Not signed in: run az login')
    process.exit(1)
  }

  const plan = registrationPlan(opts)
  const tenant = opts.tenant ?? az(['account', 'show', '--query', 'tenantId'])
  if (!tenant) {
    console.error('Could not determine the tenant: pass --tenant <id> or sign in to one with az login')
    process.exit(1)
  }

  // 1. App registration (find or create). An existing one is pinned to
  // single-tenant too, so a registration from before the multi-tenant
  // deprecation still matches the bot.
  let appId: string | null = pickExistingAppId(az(['ad', 'app', 'list', '--display-name', plan.displayName, '--query', '[].appId']), plan.displayName)
  let created = false
  if (!appId) {
    appId = az(['ad', 'app', 'create', '--display-name', plan.displayName, '--sign-in-audience', plan.audience, '--query', 'appId'])
    created = true
    note(`Created app registration ${plan.displayName} (${appId})`)
  } else {
    az(['ad', 'app', 'update', '--id', appId, '--sign-in-audience', plan.audience])
    note(`Found app registration ${plan.displayName} (${appId})`)
  }

  // 2. Client secret: first run, or on request. 24 months.
  let secret = ''
  if (created || opts.rotateSecret) {
    const label = `havn-${opts.name}-${new Date().toISOString().slice(0, 10)}`
    secret = az(['ad', 'app', 'credential', 'reset', '--id', appId, '--years', '2', '--display-name', label, '--query', 'password'])
    note('Minted a client secret (expires in 24 months)')
  }

  // 3. Resource group + Azure Bot (F0) pointing at the box
  if (!azOk(['group', 'show', '-n', opts.resourceGroup])) {
    az(['group', 'create', '-n', opts.resourceGroup, '-l', plan.groupLocation])
  }
  if (azOk(['bot', 'show', '-n', plan.botName, '-g', opts.resourceGroup])) {
    az(['bot', 'update', '-n', plan.botName, '-g', opts.resourceGroup, '--endpoint', plan.endpoint])
    note(`Updated bot ${plan.botName} endpoint -> ${plan.endpoint}`)
  } else {
    const args = [
      'bot', 'create',
      '--resource-group', opts.resourceGroup,
      '--name', plan.botName,
      '--app-type', plan.appType,
      '--appid', appId,
      '--endpoint', plan.endpoint,
      '--sku', 'F0',
      '--location', opts.location,
      '--tenant-id', tenant,
    ]
    az(args)
    note(`Created bot ${plan.botName} -> ${plan.endpoint}`)
  }

  // 4. Teams channel (idempotent; a real create failure now throws instead of
  // being swallowed as if the channel were already there)
  if (azOk(['bot', 'msteams', 'show', '-n', plan.botName, '-g', opts.resourceGroup])) {
    note('Teams channel already enabled')
  } else {
    az(['bot', 'msteams', 'create', '-n', plan.botName, '-g', opts.resourceGroup])
    note('Teams channel enabled')
  }

  // 5. Values for .env (stdout only)
  console.log(`TEAMS_APP_ID=${appId}`)
  if (secret) console.log(`TEAMS_APP_SECRET=${secret}`)
  else console.log('# TEAMS_APP_SECRET unchanged (use --rotate-secret to mint a new one)')
  console.log(`TEAMS_TENANT_ID=${tenant}`)
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(REGISTER_USAGE)
} else {
  main()
}
