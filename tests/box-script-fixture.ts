/**
 * Runs a box-side script (the bash a provisioning step sends over ssh) against
 * a fake install folder, with a stand-in vault-cli that records each
 * `set NAME` and the value it read from stdin. Lets a test check what the real
 * script does to .env and the vault instead of only what text it contains.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const FAKE_VAULT_CLI = `
const [cmd, name] = process.argv.slice(2)
let data = ''
process.stdin.on('data', (c) => (data += c))
process.stdin.on('end', () => {
  if (cmd !== 'set' || !name || !data) { console.error('fake vault: bad call'); process.exit(1) }
  require('node:fs').appendFileSync(require('node:path').join(__dirname, '..', '..', 'vault.jsonl'), JSON.stringify({ name, value: data }) + '\\n')
})
`

export interface FakeBox {
  /** The install folder, $HOME/havn, so a script's default installDir finds it. */
  dir: string
  run(script: string): { code: number; stdout: string; stderr: string }
  vault(): Record<string, string>
  env(): string | null
  cleanup(): void
}

export function fakeBox(): FakeBox {
  const home = mkdtempSync(join(tmpdir(), 'fake-box-'))
  const dir = join(home, 'havn')
  mkdirSync(join(dir, 'dist', 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'scripts', 'vault-cli.js'), FAKE_VAULT_CLI)
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}')
  return {
    dir,
    run(script) {
      const r = spawnSync('bash', ['-s'], {
        input: script,
        encoding: 'utf-8',
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
      })
      return { code: r.status ?? 255, stdout: r.stdout, stderr: r.stderr }
    },
    vault() {
      const f = join(dir, 'vault.jsonl')
      if (!existsSync(f)) return {}
      const out: Record<string, string> = {}
      for (const line of readFileSync(f, 'utf-8').split('\n').filter(Boolean)) {
        const { name, value } = JSON.parse(line) as { name: string; value: string }
        out[name] = value
      }
      return out
    },
    env() {
      const f = join(dir, '.env')
      return existsSync(f) ? readFileSync(f, 'utf-8') : null
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}
