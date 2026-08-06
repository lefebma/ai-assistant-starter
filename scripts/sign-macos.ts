/**
 * macOS signing, packaging and notarisation.
 *
 * Takes the staging tree build-installer produces and turns it into a signed,
 * notarised, stapled .pkg that a customer double-clicks. Replaces the tar.gz
 * plus `xattr -dr com.apple.quarantine` dance on macOS.
 *
 * Decisions live in src/sign/plan.ts; this is the I/O around them.
 *
 * Usage (run compiled, macOS only):
 *   node dist/scripts/sign-macos.js [options]
 *
 *   --staging <dir>    default dist-installer/staging
 *   --out <dir>        default dist-installer
 *   --app-name <name>  default $APP_NAME, then APP_NAME in .env, then "AI Assistant"
 *   --identifier <id>  default com.<slug>.app
 *   --profile <name>   notarytool keychain profile, default HAVN_NOTARY
 *   --skip-notarize    sign and package only (no Apple round trip)
 *   --dry-run          print the signing plan and stop
 *   --help             print this and exit
 *
 * Requires: Developer ID Application + Developer ID Installer certificates in
 * the keychain, and `notarytool store-credentials` already run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, rmSync, cpSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { PROJECT_ROOT, readEnvFile } from '../src/env.js'
import { parseCodesign, planBinary, nodeEntitlements, distributionXml, conclusionHtml } from '../src/sign/plan.js'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const ok = (m: string) => console.log(`  ${GREEN}✓${RESET} ${m}`)
const info = (m: string) => console.log(`  ${m}`)
const warn = (m: string) => console.log(`  ${YELLOW}⚠${RESET} ${m}`)
const header = (m: string) => console.log(`\n${BOLD}${m}${RESET}`)

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
const has = (name: string) => process.argv.includes(`--${name}`)

// Before anything else. An unrecognised flag used to fall through to a real
// signing run, so `--help` signed the tree and submitted it to Apple for
// notarisation before it could be stopped. A tool whose dry-run flag is the
// only thing standing between curiosity and an Apple round trip should answer
// --help.
if (has('help') || has('h')) {
  console.log(`
macOS signing, packaging and notarisation.

  node dist/scripts/sign-macos.js [options]

  --staging <dir>    default dist-installer/staging
  --out <dir>        default dist-installer
  --app-name <name>  default $APP_NAME, then APP_NAME in .env, then "AI Assistant"
  --identifier <id>  default com.<slug>.app
  --profile <name>   notarytool keychain profile, default HAVN_NOTARY
  --skip-notarize    sign and package only (no Apple round trip)
  --dry-run          print the signing plan and stop
  --help             print this and exit

Requires Developer ID Application + Developer ID Installer certificates in the
keychain, and \`notarytool store-credentials\` already run.
`)
  process.exit(0)
}

const STAGING = resolve(flag('staging', join(PROJECT_ROOT, 'dist-installer', 'staging'))!)
const OUT = resolve(flag('out', join(PROJECT_ROOT, 'dist-installer'))!)
// Same .env fallback as build-installer, so the package name cannot disagree
// with the launcher name baked into the staging tree it is packaging.
const APP_NAME = flag('app-name', process.env.APP_NAME || readEnvFile(['APP_NAME'])['APP_NAME'] || 'AI Assistant')!
const SLUG = APP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const IDENTIFIER = flag('identifier', `com.${SLUG}.app`)!
const PROFILE = flag('profile', 'HAVN_NOTARY')!
const DRY_RUN = has('dry-run')
const SKIP_NOTARIZE = has('skip-notarize')

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf-8', stdio: opts.quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'] })
}

/** First matching identity of the given kind, so nobody has to paste a hash. */
function findIdentity(kind: 'Developer ID Application' | 'Developer ID Installer'): string {
  // -p codesigning filters out Installer certs, so ask for everything.
  const out = run('security', ['find-identity', '-v'], { quiet: true })
  const match = out.split('\n').find((l) => l.includes(`"${kind}:`))
  if (!match) {
    throw new Error(
      `No "${kind}" certificate in the keychain. Create one at developer.apple.com ` +
        `(Certificates > +) and download it, then re-run.`
    )
  }
  return match.slice(match.indexOf('"') + 1, match.lastIndexOf('"'))
}

/** Team id out of an identity string like `Developer ID Application: Name (TEAMID)`. */
function teamOf(identity: string): string {
  const m = identity.match(/\(([A-Z0-9]{10})\)\s*$/)
  if (!m) throw new Error(`Could not read a team id out of: ${identity}`)
  return m[1]
}

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe])

/** Cheap Mach-O test: read the 4-byte magic rather than spawning file(1) per path. */
function isMachO(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(4)
    if (readSync(fd, buf, 0, 4, 0) < 4) return false
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile() && isMachO(p)) out.push(p)
  }
  return out
}

/**
 * Several of Apple's signing tools report on stderr rather than stdout, and
 * codesign exits non-zero for unsigned input. Take both streams whatever the
 * exit status: an empty result then genuinely means "nothing to read", which
 * is what the unsigned case should look like. Reading stdout alone silently
 * turns every signed binary into an apparently-unsigned one.
 */
function combinedOutput(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

function inspect(path: string): ReturnType<typeof parseCodesign> {
  const sig = combinedOutput('codesign', ['-dvv', path])
  const ents = [
    ...combinedOutput('codesign', ['-d', '--entitlements', ':-', path]).matchAll(/<key>([^<]+)<\/key>/g),
  ].map((m) => m[1])
  return parseCodesign(sig, ents)
}

function main(): void {
  if (process.platform !== 'darwin') {
    console.error('sign-macos only runs on macOS.')
    process.exit(1)
  }
  if (!existsSync(STAGING)) {
    console.error(`Staging tree not found: ${STAGING}\nRun: node dist/scripts/build-installer.js`)
    process.exit(1)
  }

  console.log(`${BOLD}\n  ${APP_NAME} — macOS signing\n${RESET}`)

  const appIdentity = findIdentity('Developer ID Application')
  const team = teamOf(appIdentity)
  ok(`signing identity: ${appIdentity}`)

  // ── 1. Sign every Mach-O the payload carries ──
  header('Inspecting binaries...')
  const binaries = walk(STAGING)
  const entitlementsPath = join(OUT, 'node.entitlements')
  const decisions = binaries.map((path) => ({ path, ...planBinary(inspect(path), team) }))

  for (const d of decisions) {
    const rel = d.path.slice(STAGING.length + 1)
    const label = d.action === 'skip' ? `${GREEN}skip${RESET}` : `${YELLOW}${d.action}${RESET}`
    info(`${label}  ${rel}\n        ${d.reason}`)
  }

  if (DRY_RUN) {
    console.log(`\n${BOLD}Dry run — nothing signed.${RESET}\n`)
    return
  }

  header('Signing...')
  mkdirSync(OUT, { recursive: true })
  writeFileSync(entitlementsPath, nodeEntitlements())

  // Deepest paths first: nested code must be signed before whatever contains it.
  const toSign = decisions.filter((d) => d.action !== 'skip').sort((a, b) => b.path.length - a.path.length)
  for (const d of toSign) {
    const args = ['--force', '--sign', appIdentity, '--timestamp', '--options', 'runtime']
    // Entitlements only for executables that need them; addons inherit nothing.
    if (d.path.endsWith('/node') || d.path.endsWith('node.exe')) args.push('--entitlements', entitlementsPath)
    args.push(d.path)
    run('codesign', args, { quiet: true })
  }
  ok(`${toSign.length} binaries signed, ${decisions.length - toSign.length} left as-is`)

  header('Verifying signatures...')
  for (const d of decisions) {
    run('codesign', ['--verify', '--strict', d.path], { quiet: true })
  }
  ok('every Mach-O passes codesign --verify --strict')

  // ── 2. Lay out the payload the way an install should look on disk ──
  // The staging tree is bundle-shaped (app/, runtime/, install.mjs); an
  // installed tree is app contents at the root with runtime/ beside them.
  header('Building package payload...')
  const payload = join(OUT, 'pkg-payload')
  rmSync(payload, { recursive: true, force: true })
  mkdirSync(payload, { recursive: true })
  cpSync(join(STAGING, 'app'), payload, { recursive: true })
  if (existsSync(join(STAGING, 'runtime'))) {
    cpSync(join(STAGING, 'runtime'), join(payload, 'runtime'), { recursive: true })
  }
  const version = run('cat', [join(payload, 'VERSION')], { quiet: true }).trim()
  ok(`payload assembled (v${version})`)

  // ── 3. Package, sign the package, notarise, staple ──
  header('Packaging...')
  const componentPkg = join(OUT, `${SLUG}-component.pkg`)
  const distPath = join(OUT, 'distribution.xml')
  const finalPkg = join(OUT, `${SLUG}-v${version}-macos.pkg`)

  run('pkgbuild', [
    '--root', payload,
    '--identifier', IDENTIFIER,
    '--version', version,
    '--install-location', `/Applications/${APP_NAME}`,
    componentPkg,
  ], { quiet: true })

  writeFileSync(
    distPath,
    distributionXml({ title: APP_NAME, componentPkg: `${SLUG}-component.pkg`, identifier: IDENTIFIER, version })
  )

  // The installer's last screen. The package deliberately launches nothing
  // itself, so this is where the customer is told what to double-click.
  const resources = join(OUT, 'pkg-resources')
  rmSync(resources, { recursive: true, force: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'conclusion.html'), conclusionHtml({ appName: APP_NAME }))

  run('productbuild', [
    '--distribution', distPath,
    '--package-path', OUT,
    '--resources', resources,
    '--sign', findIdentity('Developer ID Installer'),
    '--timestamp',
    finalPkg,
  ], { quiet: true })
  ok(`signed package: ${finalPkg}`)

  rmSync(componentPkg, { force: true })
  rmSync(distPath, { force: true })
  rmSync(resources, { recursive: true, force: true })
  rmSync(payload, { recursive: true, force: true })
  rmSync(entitlementsPath, { force: true })

  if (SKIP_NOTARIZE) {
    warn('--skip-notarize: package is signed but NOT notarised. Gatekeeper will still complain.')
    return
  }

  header('Notarising (this takes a few minutes)...')
  try {
    const out = execFileSync(
      'xcrun',
      ['notarytool', 'submit', finalPkg, '--keychain-profile', PROFILE, '--wait'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }
    )
    if (!/status:\s*Accepted/i.test(out)) {
      console.log(out)
      const id = out.match(/id:\s*([0-9a-f-]{36})/i)?.[1]
      throw new Error(
        `Notarisation did not come back Accepted.` +
          (id ? ` Run: xcrun notarytool log ${id} --keychain-profile ${PROFILE}` : '')
      )
    }
    ok('notarised')
  } catch (err) {
    console.error(`  ${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}`)
    console.error(`    If this is a credentials error, run: xcrun notarytool store-credentials "${PROFILE}"`)
    process.exit(1)
  }

  run('xcrun', ['stapler', 'staple', finalPkg], { quiet: true })
  ok('ticket stapled')

  header('Final check...')
  const assess = combinedOutput('spctl', ['-a', '-vvv', '-t', 'install', finalPkg])
  console.log(`  ${assess.split('\n').join('\n  ')}`)
  if (!/source=Notarized Developer ID/.test(assess)) {
    console.error(`  ${RED}✗${RESET} Gatekeeper did not accept the package as notarised.`)
    process.exit(1)
  }
  ok(`${finalPkg} is ready to hand to a customer`)
  console.log(`\n  Installs to ~/Applications/${APP_NAME}, no admin password.\n`)
}

try {
  main()
} catch (err: any) {
  console.error(`\n${RED}Signing failed:${RESET} ${err?.message ?? String(err)}`)
  if (err?.stderr) console.error(String(err.stderr).trim())
  process.exit(1)
}
