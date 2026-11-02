#!/usr/bin/env node
// One-time (and re-runnable) setup of the havn-connect relay, run by the
// operator on their own machine. Prints no secret.
//
//   node deploy/connect-relay/setup.mjs [path/to/google-web-client.json]
//
// - Deploys the Worker (creates connect.gethavn.ai on first run).
// - Generates SIGNING_SECRET and SEALING_SECRET if missing.
// - Generates the admin token if missing: the token goes to
//   $SECRETS_DIR/havn-connect-admin-token (mode 600), only its SHA-256 to the Worker.
// - With a Google "Web application" client JSON, sets GOOGLE_CLIENT_ID and
//   GOOGLE_CLIENT_SECRET from it.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const secretsDir = process.env.SECRETS_DIR ?? join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ClaudeClaw-Secrets')
const adminFile = join(secretsDir, 'havn-connect-admin-token')

function wrangler(args, input) {
  const r = spawnSync('npx', ['-y', 'wrangler@4', ...args], {
    cwd: here,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', input === undefined ? 'inherit' : 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) throw new Error(`wrangler ${args[0]} ${args[1] ?? ''} failed`)
  return r.stdout ?? ''
}
const putSecret = (name, value) => wrangler(['secret', 'put', name], value)

wrangler(['deploy'])

let have = []
try {
  have = JSON.parse(wrangler(['secret', 'list'], '')).map((s) => s.name)
} catch {
  have = []
}

for (const name of ['SIGNING_SECRET', 'SEALING_SECRET']) {
  if (have.includes(name)) console.log(`${name} already set`)
  else {
    putSecret(name, randomBytes(32).toString('hex'))
    console.log(`set ${name}`)
  }
}

if (have.includes('ADMIN_TOKEN_SHA256')) console.log('ADMIN_TOKEN_SHA256 already set')
else {
  if (!existsSync(adminFile)) writeFileSync(adminFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  putSecret('ADMIN_TOKEN_SHA256', createHash('sha256').update(readFileSync(adminFile, 'utf8')).digest('hex'))
  console.log(`set ADMIN_TOKEN_SHA256 (token in ${adminFile})`)
}

const clientFile = process.argv[2]
if (clientFile) {
  const web = JSON.parse(readFileSync(clientFile, 'utf8')).web
  if (!web?.client_id || !web?.client_secret) throw new Error(`${clientFile} is not a Google "Web application" client JSON`)
  putSecret('GOOGLE_CLIENT_ID', web.client_id)
  putSecret('GOOGLE_CLIENT_SECRET', web.client_secret)
  console.log(`set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from ${clientFile}`)
}

const res = await fetch('https://connect.gethavn.ai/start?provider=outlook&box=none&nonce=check-0123456789abcdef').catch(() => null)
console.log(`relay answers /start with HTTP ${res?.status ?? 'no answer'} (400 is right: no such box)`)
