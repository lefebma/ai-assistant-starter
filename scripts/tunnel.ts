/**
 * Quick-tunnel wrapper for the voice/HTTP surface. Exposes localhost via a
 * Cloudflare quick tunnel; the trycloudflare URL changes on every restart
 * (free-tier limitation). For a stable URL, use a named tunnel (needs a
 * Cloudflare account + domain).
 *
 * Usage (run compiled): node dist/scripts/tunnel.js
 * Config: HTTP_PORT (default 3030), CLOUDFLARED_PATH (default: cloudflared on PATH)
 */
import { spawn } from 'node:child_process'
import { readEnvFile } from '../src/env.js'

const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>
const bin = env.CLOUDFLARED_PATH ?? 'cloudflared'
const port = env.HTTP_PORT ?? '3030'

const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(`Failed to start ${bin}: ${String(err)}\nInstall cloudflared or set CLOUDFLARED_PATH in .env.`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
