/**
 * BYOK vault public surface (Phase 4 slice a).
 *
 * getSecret() is the additive resolver: vault → .env → process.env. It is
 * non-breaking by construction — an install that has migrated nothing keeps
 * reading .env exactly as before, and a secret moved into the vault simply
 * wins. Consumers (provider key resolution, bot token, etc.) can migrate to
 * this without any behavior change until secrets are actually vaulted.
 */
import { readEnvFile } from '../env.js'
import { SecretVault } from './store.js'

export { SecretVault, defaultVaultDir } from './store.js'
export { encrypt, decrypt, newKey, type Envelope } from './crypto.js'

/**
 * Vault at the default location, honoring AGENT_VAULT_DIR (the installer points
 * this at the OS config dir). Not memoized: each call re-reads AGENT_VAULT_DIR so
 * tests can redirect it, and a vault edited out-of-band by the CLI is picked up
 * without a restart. Reads are cheap (a small decrypt) and infrequent.
 */
export function defaultVault(): SecretVault {
  const dir = process.env.AGENT_VAULT_DIR?.trim()
  return new SecretVault(dir ? { dir } : {})
}

/**
 * Resolve a secret by name: vault → .env → process.env. Mirrors the codebase's
 * `x?.trim() || next` precedence — a whitespace-only value counts as unset and
 * falls through, and the returned value is trimmed. Returns undefined if it
 * exists (non-empty) in none of them.
 */
export function getSecret(name: string, vault: SecretVault = defaultVault()): string | undefined {
  return (
    vault.get(name)?.trim() ||
    readEnvFile()[name]?.trim() ||
    process.env[name]?.trim() ||
    undefined
  )
}
