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
const PENDING_PREFIX = 'MS_PENDING_'

/** Folds anything a secret name cannot carry. */
function slug(account: string): string {
  const s = account.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) throw new Error('Microsoft account label cannot be empty')
  return s
}

/** Vault key for an account label. */
export function tokenSecretName(account: string): string {
  return `${PREFIX}${slug(account)}`
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

/**
 * A sign-in that has been started and not finished. It sits in the vault, not
 * in memory, because in chat the two halves are separate processes: the code
 * is shown, the owner goes off to a browser, and a later turn collects the
 * result. The device code is redeemable by whoever holds it for those fifteen
 * minutes, so it is a secret for exactly as long as it matters.
 */
export interface PendingSignIn {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSecs: number
  /** Epoch seconds. */
  expiresAt: number
}

export function pendingSecretName(account: string): string {
  return `${PENDING_PREFIX}${slug(account)}`
}

export function savePending(account: string, pending: PendingSignIn, vault: TokenVault = defaultVault()): void {
  vault.set(pendingSecretName(account), JSON.stringify(pending))
}

export function loadPending(account: string, vault: TokenVault = defaultVault()): PendingSignIn | null {
  const raw = vault.get(pendingSecretName(account))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<PendingSignIn>
    if (typeof p.deviceCode !== 'string' || typeof p.expiresAt !== 'number') return null
    return {
      deviceCode: p.deviceCode,
      userCode: p.userCode ?? '',
      verificationUri: p.verificationUri ?? 'https://microsoft.com/devicelogin',
      intervalSecs: typeof p.intervalSecs === 'number' ? p.intervalSecs : 5,
      expiresAt: p.expiresAt,
    }
  } catch {
    return null
  }
}

export function clearPending(account: string, vault: TokenVault = defaultVault()): boolean {
  return vault.delete(pendingSecretName(account))
}
