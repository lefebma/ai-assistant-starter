/**
 * Encrypted secret store for the BYOK vault (Phase 4 slice a).
 *
 * Single-tenant, on the customer's machine: one AES-256-GCM blob of
 * {name: value} secrets (`secrets.json`) plus a master key held by a
 * KeyBackend — a 0600 `vault.key` file by default, or the OS credential
 * store (macOS Keychain / Windows Credential Manager) when
 * VAULT_KEY_BACKEND=keyring. Keeping the key out of the blob means an
 * accidentally committed or cloud-synced `secrets.json` leaks nothing
 * without the key.
 *
 * Values are never logged and never returned by list() (names only).
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import { decrypt, encrypt, newKey, type Envelope } from './crypto.js'
import { ensureOwnerDir, resolveKeyBackend, type KeyBackend } from './key-backend.js'

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

export class SecretVault {
  private readonly dir: string
  private readonly secretsPath: string
  private readonly keyBackend: KeyBackend
  /** Lazily loaded, decrypted map. null until first access. */
  private cache: Record<string, string> | null = null
  /** Master key, cached per instance after first resolve. */
  private key: Buffer | null = null

  constructor(opts: { dir?: string; keyBackend?: KeyBackend } = {}) {
    this.dir = opts.dir ?? defaultVaultDir()
    this.secretsPath = join(this.dir, 'secrets.json')
    this.keyBackend = opts.keyBackend ?? resolveKeyBackend(this.dir)
  }

  /** Create the vault dir owner-only (0700); the secret files live here. */
  private ensureDir(): void {
    ensureOwnerDir(this.dir)
  }

  /** Load the 32-byte key from the backend, generating it on first use. */
  private loadKey(): Buffer {
    if (this.key) return this.key
    let key = this.keyBackend.getKey()
    if (!key) {
      key = newKey()
      this.keyBackend.setKey(key)
    }
    this.key = key
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
