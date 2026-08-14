/**
 * Can this install actually reach a model?
 *
 * This is the question setup and the self-test both used to skip. The old
 * requirement check asked whether a `claude` command existed on PATH, which is
 * neither necessary (the SDK vendors its own binary) nor sufficient (an
 * installed CLI that has never been signed in gets you nowhere). The result
 * was an install that finished clean, self-tested green, and then failed to
 * answer the owner's first message with no clue as to why.
 *
 * Pure on purpose: the caller supplies the auth status and an env reader, so
 * every branch is testable and neither the wizard nor the self-test has to
 * duplicate the reasoning.
 */

/** Env var carrying each ai-sdk provider's key. Mirrors runtime/ai-sdk/provider.ts. */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
}

export interface CredentialInputs {
  /** Resolved AGENT_RUNTIME for the lane being checked. */
  runtime: string
  /** AI_PROVIDER, when runtime is 'ai-sdk'. Defaults to anthropic. */
  provider?: string
  /** Reads a configured value (.env, then process env). */
  env: (name: string) => string | undefined
  /** Whether this machine has usable Claude credentials. */
  signedIn: boolean
  /** How, in plain English, from AuthStatus.detail. Used verbatim when set. */
  signInDetail?: string
}

export interface CredentialStatus {
  ok: boolean
  /** What we found, for the check line. */
  detail: string
  /** Plain-English next step when not ok. Absent when ok. */
  remedy?: string
}

export function checkCredentials(io: CredentialInputs): CredentialStatus {
  const has = (name: string) => Boolean(io.env(name)?.trim())

  if (io.runtime === 'ai-sdk') {
    const provider = io.provider?.trim() || 'anthropic'
    const keyName = PROVIDER_KEY_ENV[provider]
    if (!keyName) {
      return {
        ok: false,
        detail: `unknown AI_PROVIDER '${provider}'`,
        remedy: `Set AI_PROVIDER in .env to one of: ${Object.keys(PROVIDER_KEY_ENV).join(', ')}.`,
      }
    }
    if (has(keyName)) return { ok: true, detail: `${provider} API key configured` }
    return {
      ok: false,
      detail: `no ${provider} API key`,
      remedy: `Add ${keyName}=your-key to .env. Your assistant cannot answer without it.`,
    }
  }

  if (io.runtime !== 'claude') {
    return {
      ok: false,
      detail: `unknown AGENT_RUNTIME '${io.runtime}'`,
      remedy: "Set AGENT_RUNTIME in .env to 'claude' or 'ai-sdk'.",
    }
  }

  // The claude runtime authenticates one of two ways: an interactive sign-in
  // held in the OS credential store, or ANTHROPIC_API_KEY, which Claude Code
  // honours as an auth method in its own right (not only as the overflow lane
  // this project uses it for).
  if (io.signedIn) return { ok: true, detail: io.signInDetail?.trim() || 'signed in to Claude on this machine' }
  if (has('ANTHROPIC_API_KEY')) return { ok: true, detail: 'ANTHROPIC_API_KEY configured' }

  return {
    ok: false,
    detail: 'no Claude sign-in and no API key on this machine',
    remedy:
      'Sign in with a Claude Pro or Max account (re-run setup, or run the Sign in step in ' +
      'docs/SETUP-GUIDE.md), or add ANTHROPIC_API_KEY=your-key to .env to pay per use instead.',
  }
}
