/**
 * Render a Teams app package for one install.
 *
 *   npm run teams-manifest -- --app-id <guid> --name "Nami" [--developer "ELS Partners"]
 *                              [--website https://www.els-partners.com] [--out deploy/rendered/nami-teams.zip]
 *
 * Upload the zip in Teams: Apps → Manage your apps → Upload an app → Upload a
 * custom app (or have the tenant admin publish it to the org catalog).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'
import { buildTeamsPackage, slugify, validateTeamsPackageSpec, type TeamsPackageSpec } from '../src/deploy/teams-package.js'

const USAGE = 'Usage: npm run teams-manifest -- --app-id <guid> --name "<assistant name>" [--developer <name>] [--website <url>] [--out <path.zip>]'

function parseArgs(argv: string[]): TeamsPackageSpec & { out?: string } {
  const opts: TeamsPackageSpec & { out?: string } = { appId: '', name: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`)
      return v
    }
    if (arg === '--app-id') opts.appId = next()
    else if (arg === '--name') opts.name = next()
    else if (arg === '--developer') opts.developerName = next()
    else if (arg === '--website') opts.websiteUrl = next()
    else if (arg === '--out') opts.out = next()
    else if (arg === '--help' || arg === '-h') throw new Error(USAGE)
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
  }
  return opts
}

function main(): void {
  let opts: ReturnType<typeof parseArgs>
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  }
  const problems = validateTeamsPackageSpec(opts)
  if (problems.length) {
    for (const p of problems) console.error(`- ${p}`)
    console.error(USAGE)
    process.exit(1)
  }
  const template = readFileSync(resolve(PROJECT_ROOT, 'deploy', 'teams', 'manifest.json.template'), 'utf-8')
  const zip = buildTeamsPackage(template, opts)
  const outFile = resolve(PROJECT_ROOT, opts.out ?? `deploy/rendered/${slugify(opts.name)}-teams.zip`)
  mkdirSync(resolve(outFile, '..'), { recursive: true })
  writeFileSync(outFile, zip)
  console.log(`Wrote ${outFile} (${zip.length} bytes).`)
  console.log('Install it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.')
}

main()
