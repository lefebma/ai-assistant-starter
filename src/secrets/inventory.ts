/**
 * What is actually configured, and where the value comes from.
 *
 * getSecret() resolves vault -> .env -> process.env, so the vault alone is a
 * partial answer: a client whose keys landed in .env at install time has a
 * fully working assistant and an empty vault. `/secret list` reporting only
 * the vault told them "nothing is set", which is both wrong and alarming.
 *
 * This module rebuilds the resolver's view for display. Values are masked to
 * a four-character tail — enough to tell two keys apart or match one against
 * a provider dashboard, not enough to use.
 */

/** Names the engine actually resolves through the vault (see docs/VAULT.md). */
export const KNOWN_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'HTTP_BEARER_TOKEN',
] as const

export function maskSecret(value: string): string {
  const v = value.trim()
  if (v.length < 9) return '••••••'
  return `••••${v.slice(-4)}`
}

/**
 * A .env key worth listing. Skills and MCP servers keep their keys in .env
 * under names the engine never reads (PERPLEXITY_API_KEY, NOTION_TOKEN), and
 * those are exactly what a client wants to see. Everything else in .env is
 * configuration — timezone, chat id, model name — and does not belong in a
 * secret list.
 */
const SECRET_NAME_RE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)(_|$)/

/** Config that trips SECRET_NAME_RE without being a secret. */
const NOT_SECRETS = new Set(['VAULT_KEY_BACKEND'])

export function looksLikeSecretName(name: string): boolean {
  return !NOT_SECRETS.has(name) && SECRET_NAME_RE.test(name)
}

export type SecretSource = 'vault' | 'env-file' | 'process-env'

export const SOURCE_LABELS: Record<SecretSource, string> = {
  vault: 'Encrypted vault',
  'env-file': '.env file',
  'process-env': 'Service environment',
}

/** Same three sources, as they read mid-sentence. */
const SOURCE_PHRASES: Record<SecretSource, string> = {
  vault: 'the vault',
  'env-file': '.env',
  'process-env': 'the service environment',
}

export interface SecretEntry {
  name: string
  /** The source the engine actually resolves this name from. */
  source: SecretSource
  masked: string
  /** Sources that also hold a value but lose to `source`. */
  alsoIn: SecretSource[]
  /** True when the engine itself reads this name. */
  known: boolean
}

export interface SecretInventory {
  set: SecretEntry[]
  /** Engine keys with no value in any source. */
  missing: string[]
}

export interface InventorySources {
  vault: Record<string, string>
  envFile: Record<string, string>
  processEnv: Record<string, string | undefined>
}

/** Resolution order, highest precedence first. Mirrors getSecret(). */
const ORDER: SecretSource[] = ['vault', 'env-file', 'process-env']

export function buildSecretInventory(sources: InventorySources): SecretInventory {
  const bySource: Record<SecretSource, Record<string, string | undefined>> = {
    vault: sources.vault,
    'env-file': sources.envFile,
    'process-env': sources.processEnv,
  }

  // Candidates come from the engine's own list, from whatever is in the vault,
  // and from secret-looking .env keys. process.env is deliberately not scanned
  // for new names: on a hosted box it carries the whole service environment,
  // and half of it would be noise.
  const candidates = new Set<string>([
    ...KNOWN_SECRET_NAMES,
    ...Object.keys(sources.vault),
    ...Object.keys(sources.envFile).filter(looksLikeSecretName),
  ])

  const set: SecretEntry[] = []
  const missing: string[] = []

  for (const name of [...candidates].sort()) {
    const present = ORDER.filter((s) => (bySource[s][name] ?? '').trim().length > 0)
    if (present.length === 0) {
      // Only nag about keys the engine reads. A vault name the engine ignores
      // cannot be "missing", and an empty PERPLEXITY_API_KEY is the skill's
      // business, not ours.
      if ((KNOWN_SECRET_NAMES as readonly string[]).includes(name)) missing.push(name)
      continue
    }
    const source = present[0]
    set.push({
      name,
      source,
      masked: maskSecret((bySource[source][name] ?? '').trim()),
      alsoIn: present.slice(1),
      known: (KNOWN_SECRET_NAMES as readonly string[]).includes(name),
    })
  }

  return { set, missing }
}

/** Render the inventory as the plain-text body of a /secret list reply. */
export function formatSecretInventory(inv: SecretInventory): string {
  const lines: string[] = []

  if (inv.set.length === 0) {
    lines.push('No API keys are configured yet, in the vault or in .env.')
  } else {
    lines.push('Keys in use (values are masked - the last 4 characters only):')
    for (const source of ORDER) {
      const entries = inv.set.filter((e) => e.source === source)
      if (entries.length === 0) continue
      lines.push('', `${SOURCE_LABELS[source]}:`)
      for (const e of entries) {
        lines.push(`- ${e.name}  ${e.masked}${e.known ? '' : '  (not read by the engine)'}`)
      }
    }

    const shadowed = inv.set.filter((e) => e.alsoIn.length > 0)
    if (shadowed.length > 0) {
      lines.push('')
      for (const e of shadowed) {
        lines.push(
          `Note: ${e.name} is also set in ${e.alsoIn.map((s) => SOURCE_PHRASES[s]).join(' and ')}, ` +
            `overridden by ${SOURCE_PHRASES[e.source]}.`
        )
      }
    }
  }

  if (inv.missing.length > 0) {
    lines.push('', `Not set anywhere: ${inv.missing.join(', ')}`)
  }

  lines.push('', 'Order of precedence: vault, then .env, then the service environment.')
  lines.push('Move a key into the vault with /secret set <NAME>.')

  return lines.join('\n')
}
