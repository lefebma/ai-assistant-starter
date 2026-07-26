#!/usr/bin/env node
// Installer entry point shipped at the root of the install bundle.
// Zero dependencies; runs with the bundled runtime or any Node >= 18.
//
//   node install.mjs [--dir <target>] [--run-setup]
//
// Copies the app payload (and bundled runtime, when present) into the
// target directory, then prints — or with --run-setup, launches — the
// setup wizard using the bundled runtime.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const dirIdx = process.argv.indexOf('--dir')
const target = resolve(dirIdx !== -1 ? process.argv[dirIdx + 1] : join(homedir(), 'ai-assistant'))

console.log(`Installing to ${target} ...`)
mkdirSync(target, { recursive: true })
cpSync(join(here, 'app'), target, { recursive: true })

let nodeBin = process.execPath // fallback: whatever ran this script
if (existsSync(join(here, 'runtime'))) {
  cpSync(join(here, 'runtime'), join(target, 'runtime'), { recursive: true })
  nodeBin =
    process.platform === 'win32' ? join(target, 'runtime', 'node.exe') : join(target, 'runtime', 'bin', 'node')
  console.log('Bundled Node runtime installed (your system Node is not used).')
}

console.log(`
Installed. Next steps (run from ${target}):

  1. Set up:            "${nodeBin}" dist/scripts/setup.js
  2. Verify:            "${nodeBin}" dist/src/index.js --selftest
  3. Run as a service:  "${nodeBin}" dist/scripts/service.js install
`)

if (process.argv.includes('--run-setup')) {
  const result = spawnSync(nodeBin, [join(target, 'dist', 'scripts', 'setup.js')], {
    cwd: target,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 0)
}
