/**
 * Master-key storage backends for the vault (Phase 5 keyring slice).
 *
 * The vault's AES-256-GCM master key can live in:
 *   - file (default): a 0600 `vault.key` file next to the encrypted blob —
 *     the original zero-dependency behavior, byte-compatible with existing
 *     installs, and the fallback for headless machines.
 *   - keyring (opt-in, VAULT_KEY_BACKEND=keyring): the OS credential store
 *     via @napi-rs/keyring — macOS Keychain, Windows Credential Manager
 *     (DPAPI), Linux Secret Service. This is the Windows-correct answer:
 *     NTFS has no POSIX mode bits, so a key FILE can't be locked to the
 *     owner there, but a DPAPI credential can.
 *
 * The native module is loaded lazily inside the keyring backend, so
 * file-backend users never touch it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { readEnvFile } from '../env.js'

const KEY_BYTES = 32
const OWNER_ONLY = 0o600
const OWNER_ONLY_DIR = 0o700

export interface KeyBackend {
  readonly id: string
  /** The 32-byte master key, or null when none has been stored yet. */
  getKey(): Buffer | null
  setKey(key: Buffer): void
}

/** Create dir owner-only, enforcing 0700 even if it pre-existed. */
export function ensureOwnerDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR })
  try {
    chmodSync(dir, OWNER_ONLY_DIR)
  } catch {
    /* best effort: a parent we don't own shouldn't abort a write */
  }
}

export class FileKeyBackend implements KeyBackend {
  readonly id = 'file'
  private readonly keyPath: string

  constructor(private readonly dir: string) {
    this.keyPath = join(dir, 'vault.key')
  }

  getKey(): Buffer | null {
    if (!existsSync(this.keyPath)) return null
    const key = readFileSync(this.keyPath)
    if (key.length !== KEY_BYTES) throw new Error(`corrupt vault key at ${this.keyPath} (expected ${KEY_BYTES} bytes)`)
    return key
  }

  setKey(key: Buffer): void {
    ensureOwnerDir(this.dir)
    writeFileSync(this.keyPath, key, { mode: OWNER_ONLY })
    chmodSync(this.keyPath, OWNER_ONLY) // enforce even if umask widened the create mode
  }
}

interface EntryLike {
  getPassword(): string
  setPassword(password: string): void
}

export class KeyringKeyBackend implements KeyBackend {
  readonly id = 'keyring'
  private readonly service: string
  private readonly account: string
  private readonly entryFactory: (service: string, account: string) => EntryLike
  private entry: EntryLike | null = null

  constructor(opts: { service?: string; account?: string; entryFactory?: (service: string, account: string) => EntryLike } = {}) {
    this.service = opts.service ?? 'ai-assistant-vault'
    this.account = opts.account ?? 'master-key'
    this.entryFactory =
      opts.entryFactory ??
      ((service, account) => {
        // Lazy: the native module loads only when the keyring backend is used.
        const require = createRequire(import.meta.url)
        const { Entry } = require('@napi-rs/keyring') as { Entry: new (s: string, a: string) => EntryLike }
        return new Entry(service, account)
      })
  }

  private getEntry(): EntryLike {
    if (!this.entry) this.entry = this.entryFactory(this.service, this.account)
    return this.entry
  }

  getKey(): Buffer | null {
    let stored: string
    try {
      stored = this.getEntry().getPassword()
    } catch {
      return null // no entry in the credential store yet
    }
    const key = Buffer.from(stored, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(`corrupt vault key in OS credential store (service "${this.service}")`)
    }
    return key
  }

  setKey(key: Buffer): void {
    this.getEntry().setPassword(key.toString('base64'))
  }
}

/** Backend from config: VAULT_KEY_BACKEND=keyring opts in; file is the default. */
export function resolveKeyBackend(dir: string): KeyBackend {
  const configured = (readEnvFile()['VAULT_KEY_BACKEND'] ?? process.env.VAULT_KEY_BACKEND ?? '').trim().toLowerCase()
  if (configured === 'keyring') return new KeyringKeyBackend()
  return new FileKeyBackend(dir)
}
