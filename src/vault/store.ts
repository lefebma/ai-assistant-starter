/**
 * Encrypted secret store for the BYOK vault (Phase 4 slice a).
 *
 * Single-tenant, on the customer's machine: one AES-256-GCM blob of
 * {name: value} secrets (`secrets.json`) plus a separate 0600 master-key file
 * (`vault.key`). Keeping the key out of the blob means an accidentally
 * committed or cloud-synced `secrets.json` leaks nothing without the key file.
 *
 * The OS-keychain backend (@napi-rs/keyring, macOS Keychain / Windows
 * Credential Manager) will slot behind this same shape later; this is the
 * "encrypted-file fallback" from the design doc's Section 8, built first with
 * zero new dependencies.
 *
 * Values are never logged and never returned by list() (names only).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import { decrypt, encrypt, newKey, type Envelope } from './crypto.js'

/**
 * Default vault location. A function (not a top-level const) so importing this
 * module never dereferences PROJECT_ROOT at eval time — that would form a
 * config <-> vault import cycle once config.ts resolves its secrets through the
 * vault. Resolved lazily at construction, by which point config is initialized.
 */
export function defaultVaultDir(): string {
  return resolve(PROJECT_ROOT, 'store', 'vault')
}

const OWNER_ONLY = 0o600
const OWNER_ONLY_DIR = 0o700

export class SecretVault {
  private readonly dir: string
  private readonly keyPath: string
  private readonly secretsPath: string
  /** Lazily loaded, decrypted map. null until first access. */
  private cache: Record<string, string> | null = null

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir ?? defaultVaultDir()
    this.keyPath = join(this.dir, 'vault.key')
    this.secretsPath = join(this.dir, 'secrets.json')
  }

  /** Create the vault dir owner-only (0700); the secret files live here. */
  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: OWNER_ONLY_DIR })
    try {
      chmodSync(this.dir, OWNER_ONLY_DIR) // enforce even if the dir pre-existed or umask widened it
    } catch {
      /* best effort: a parent we don't own shouldn't abort a write */
    }
  }

  /** Load the 32-byte key, creating it (0600) on first use. */
  private loadKey(): Buffer {
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath)
      if (key.length !== 32) throw new Error(`corrupt vault key at ${this.keyPath} (expected 32 bytes)`)
      return key
    }
    this.ensureDir()
    const key = newKey()
    writeFileSync(this.keyPath, key, { mode: OWNER_ONLY })
    chmodSync(this.keyPath, OWNER_ONLY) // enforce even if umask widened the create mode
    return key
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    if (!existsSync(this.secretsPath)) {
      this.cache = {}
      return this.cache
    }
    const env = JSON.parse(readFileSync(this.secretsPath, 'utf-8')) as Envelope
    this.cache = JSON.parse(decrypt(env, this.loadKey())) as Record<string, string>
    return this.cache
  }

  private persist(map: Record<string, string>): void {
    this.ensureDir()
    const env = encrypt(JSON.stringify(map), this.loadKey())
    writeFileSync(this.secretsPath, JSON.stringify(env), { mode: OWNER_ONLY })
    chmodSync(this.secretsPath, OWNER_ONLY)
    this.cache = map
  }

  get(name: string): string | undefined {
    return this.load()[name]
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.load(), name)
  }

  /** Names only, sorted. Never returns values. */
  list(): string[] {
    return Object.keys(this.load()).sort()
  }

  set(name: string, value: string): void {
    const map = { ...this.load(), [name]: value }
    this.persist(map)
  }

  /** Returns true if the name existed and was removed. */
  delete(name: string): boolean {
    const map = this.load()
    if (!Object.prototype.hasOwnProperty.call(map, name)) return false
    const next = { ...map }
    delete next[name]
    this.persist(next)
    return true
  }
}
