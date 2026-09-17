/**
 * Where Microsoft tokens live.
 *
 * In the vault, not in .env and not in a dotfile in the home directory. A
 * refresh token is a long-lived credential for someone's mail: it reads,
 * drafts and sends. The originals cached it as plain JSON at
 * ~/.outlook-email-token.json, which is fine for one person's laptop and not
 * fine for a product that also runs on a shared VPS.
 *
 * One entry per account, so a second mailbox cannot overwrite the first.
 */
import { defaultVault } from '../vault/index.js'
import type { MsTokens } from './auth.js'

/** The subset of the vault this module needs, so tests need no key material. */
export interface TokenVault {
  get(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): boolean
  list(): string[]
}

const PREFIX = 'MS_TOKENS_'

/** Vault key for an account label. Folds anything a secret name cannot carry. */
export function tokenSecretName(account: string): string {
  const slug = account.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) throw new Error('Microsoft account label cannot be empty')
  return `${PREFIX}${slug}`
}

export function saveTokens(account: string, tokens: MsTokens, vault: TokenVault = defaultVault()): void {
  vault.set(tokenSecretName(account), JSON.stringify(tokens))
}

/**
 * Null covers every kind of "not usable": absent, unparseable, or the right
 * shape for something else. A corrupt entry sends the owner back through
 * sign-in; it does not take the turn down.
 */
export function loadTokens(account: string, vault: TokenVault = defaultVault()): MsTokens | null {
  const raw = vault.get(tokenSecretName(account))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MsTokens>
    if (typeof parsed.refreshToken !== 'string' || typeof parsed.accessToken !== 'string') return null
    if (typeof parsed.expiresAt !== 'number') return null
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

export function clearTokens(account: string, vault: TokenVault = defaultVault()): boolean {
  return vault.delete(tokenSecretName(account))
}

/** Account labels that have completed sign-in. */
export function listAuthedAccounts(vault: TokenVault = defaultVault()): string[] {
  return vault.list().filter((n) => n.startsWith(PREFIX)).map((n) => n.slice(PREFIX.length))
}
