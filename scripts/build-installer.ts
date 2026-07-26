/**
 * Build a self-contained install bundle for the CURRENT platform (per-OS
 * artifacts come from the CI matrix, each runner building its own).
 *
 * Bundle layout (tar.gz):
 *   install.mjs          zero-dep installer (run with any Node >= 18)
 *   app/                 dist/ + templates/ + docs/ + production node_modules
 *   runtime/             pinned Node runtime (omitted with --no-runtime)
 *   app/tools/winsw/     pinned winsw (Windows builds only)
 *
 * Usage (run compiled): node dist/scripts/build-installer.js [--no-runtime] [--out <dir>]
 *   --no-runtime: skip the Node/winsw downloads (CI smoke uses system node)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../src/env.js'
import {
  NODE_BUNDLE_VERSION,
  WINSW,
  downloadVerified,
  fetchNodeShasums,
  nodeDistName,
  parseShasums,
} from '../src/installer/node-dist.js'

const NO_RUNTIME = process.argv.includes('--no-runtime')
const outIdx = process.argv.indexOf('--out')
const OUT = resolve(PROJECT_ROOT, outIdx !== -1 ? process.argv[outIdx + 1] : 'dist-installer')

const APP_FILES = ['dist', 'templates', 'docs', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'VERSION', '.env.example']

async function main(): Promise<void> {
  if (!existsSync(resolve(PROJECT_ROOT, 'dist', 'src', 'index.js'))) {
    console.error('dist/ missing - run npm run build first')
    process.exit(1)
  }

  const staging = join(OUT, 'staging')
  rmSync(staging, { recursive: true, force: true })
  const app = join(staging, 'app')
  mkdirSync(app, { recursive: true })

  console.log('staging app payload...')
  for (const f of APP_FILES) {
    const src = resolve(PROJECT_ROOT, f)
    if (existsSync(src)) cpSync(src, join(app, f), { recursive: true })
  }

  console.log('installing production dependencies (npm ci --omit=dev)...')
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: app,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (!NO_RUNTIME) {
    const version = NODE_BUNDLE_VERSION
    const distName = nodeDistName(process.platform, process.arch, version)
    console.log(`downloading pinned runtime ${distName} (verified against SHASUMS256.txt)...`)
    const shasums = await fetchNodeShasums(version)
    const archive = await downloadVerified(`https://nodejs.org/dist/v${version}/${distName}`, parseShasums(shasums, distName))
    const tmpArchive = join(tmpdir(), distName)
    writeFileSync(tmpArchive, archive)
    execFileSync('tar', ['-xf', tmpArchive, '-C', staging])
    rmSync(tmpArchive, { force: true })
    const extracted = readdirSync(staging).find((d) => d.startsWith(`node-v${version}-`))
    if (!extracted) throw new Error('extracted node runtime directory not found')
    renameSync(join(staging, extracted), join(staging, 'runtime'))
    console.log('runtime bundled')

    if (process.platform === 'win32') {
      console.log(`downloading winsw v${WINSW.version} (pinned sha256)...`)
      const winsw = await downloadVerified(WINSW.url, WINSW.sha256)
      const winswDir = join(app, 'tools', 'winsw')
      mkdirSync(winswDir, { recursive: true })
      writeFileSync(join(winswDir, 'ai-assistant-service.exe'), winsw)
      console.log('winsw bundled')
    }
  } else {
    console.log('--no-runtime: skipping Node/winsw downloads')
  }

  cpSync(resolve(PROJECT_ROOT, 'scripts', 'install-payload.mjs'), join(staging, 'install.mjs'))

  const version = readFileSync(resolve(PROJECT_ROOT, 'VERSION'), 'utf-8').trim()
  const artifact = join(OUT, `ai-assistant-v${version}-${process.platform}-${process.arch}.tar.gz`)
  console.log('archiving...')
  execFileSync('tar', ['-czf', artifact, '-C', staging, '.'])
  console.log(`\nbundle: ${artifact}`)
  console.log(`staging kept at ${staging} (used by the CI smoke test)`)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
