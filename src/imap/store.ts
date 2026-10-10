/**
 * Where IMAP mailboxes are kept: in the vault, one pair of entries each.
 *
 * The password and the server settings are separate entries on purpose. The
 * password entry's name is one an owner can type into /secret set, so on a
 * hosted box the app password goes from their phone into the vault without
 * passing through the model or an SSH session. The settings entry is only
 * written once a sign-in has actually worked, which makes "has settings" the
 * same thing as "connected".
 */
import { defaultVault } from '../vault/index.js'
import type { ServerEndpoint } from './presets.js'

export interface ImapVault {
  get(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): boolean
  list(): string[]
}

export interface ImapAccount {
  address: string
  provider: string
  imap: ServerEndpoint
  smtp: ServerEndpoint
  savesSent: boolean
  /** The login name, when the provider wants something other than the address. */
  user?: string
}

const ACCOUNT_PREFIX = 'IMAP_ACCOUNT_'
const PASSWORD_PREFIX = 'IMAP_PASSWORD_'

/** Secret names are capitals, digits and underscores, at most 64 long (/secret's rule). */
const MAX_NAME = 64

function slug(address: string): string {
  const s = address.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) throw new Error('Email address cannot be empty.')
  return s
}

export function accountSecretName(address: string): string {
  return `${ACCOUNT_PREFIX}${slug(address)}`.slice(0, MAX_NAME)
}

/** The name an owner types after /secret set to store this mailbox's app password. */
export function passwordSecretName(address: string): string {
  const name = `${PASSWORD_PREFIX}${slug(address)}`
  if (name.length > MAX_NAME) {
    throw new Error(`${address} is too long to name a vault entry after. Use a shorter --account label.`)
  }
  return name
}

/**
 * App passwords are shown in groups ("abcd efgh ijkl mnop") and copied with
 * the spaces. None of the providers here put a space in a real one.
 */
export function normalisePassword(raw: string): string {
  return raw.replace(/\s+/g, '')
}

export function savePassword(address: string, password: string, vault: ImapVault = defaultVault()): void {
  vault.set(passwordSecretName(address), normalisePassword(password))
}

export function loadPassword(address: string, vault: ImapVault = defaultVault()): string | null {
  const v = vault.get(passwordSecretName(address))
  return v ? normalisePassword(v) : null
}

export function saveAccount(account: ImapAccount, vault: ImapVault = defaultVault()): void {
  vault.set(accountSecretName(account.address), JSON.stringify(account))
}

function validEndpoint(e: unknown): e is ServerEndpoint {
  const x = e as Partial<ServerEndpoint> | undefined
  return !!x && typeof x.host === 'string' && typeof x.port === 'number' && typeof x.secure === 'boolean'
}

/** Null for absent or unreadable: a corrupt entry means "connect it again", not a crash. */
export function loadAccount(address: string, vault: ImapVault = defaultVault()): ImapAccount | null {
  const raw = vault.get(accountSecretName(address))
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as Partial<ImapAccount>
    if (typeof a.address !== 'string' || !validEndpoint(a.imap) || !validEndpoint(a.smtp)) return null
    return {
      address: a.address,
      provider: typeof a.provider === 'string' ? a.provider : 'IMAP',
      imap: a.imap,
      smtp: a.smtp,
      savesSent: a.savesSent === true,
      ...(typeof a.user === 'string' && a.user ? { user: a.user } : {}),
    }
  } catch {
    return null
  }
}

/** Removes both entries. True when there was anything to remove. */
export function removeAccount(address: string, vault: ImapVault = defaultVault()): boolean {
  const a = vault.delete(accountSecretName(address))
  let p = false
  try {
    p = vault.delete(passwordSecretName(address))
  } catch {
    // An address too long for a password name never had one stored.
  }
  return a || p
}

/** Every connected mailbox, by its address. */
export function listAccounts(vault: ImapVault = defaultVault()): ImapAccount[] {
  const out: ImapAccount[] = []
  for (const name of vault.list()) {
    if (!name.startsWith(ACCOUNT_PREFIX)) continue
    const raw = vault.get(name)
    if (!raw) continue
    try {
      const addr = (JSON.parse(raw) as { address?: unknown }).address
      if (typeof addr !== 'string') continue
      const a = loadAccount(addr, vault)
      if (a) out.push(a)
    } catch {
      // Skip an unreadable entry rather than hide every other mailbox.
    }
  }
  return out.sort((x, y) => x.address.localeCompare(y.address))
}
