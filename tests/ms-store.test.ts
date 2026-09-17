import { describe, it, expect } from 'vitest'
import { tokenSecretName, saveTokens, loadTokens, clearTokens, listAuthedAccounts } from '../src/ms/store.js'
import type { MsTokens } from '../src/ms/auth.js'

function fakeVault(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    get: (n: string) => data.get(n),
    set: (n: string, v: string) => void data.set(n, v),
    delete: (n: string) => data.delete(n),
    list: () => [...data.keys()],
    has: (n: string) => data.has(n),
    data,
  }
}

const TOK: MsTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 }

describe('tokenSecretName', () => {
  it('namespaces by account so two mailboxes cannot overwrite each other', () => {
    expect(tokenSecretName('work')).not.toBe(tokenSecretName('personal'))
  })

  it('is stable and upper-cased, matching the rest of the vault', () => {
    expect(tokenSecretName('work')).toBe('MS_TOKENS_WORK')
  })

  it('folds characters a secret name cannot carry', () => {
    expect(tokenSecretName('marc.l@els-partners.com')).toBe('MS_TOKENS_MARC_L_ELS_PARTNERS_COM')
  })

  it('refuses an empty account rather than writing a shared bucket', () => {
    expect(() => tokenSecretName('  ')).toThrow(/account/i)
  })
})

describe('saveTokens / loadTokens', () => {
  it('round-trips through the vault', () => {
    const v = fakeVault()
    saveTokens('work', TOK, v as never)
    expect(loadTokens('work', v as never)).toEqual(TOK)
  })

  it('puts the refresh token in the vault, never in .env', () => {
    const v = fakeVault()
    saveTokens('work', TOK, v as never)
    expect(v.data.get('MS_TOKENS_WORK')).toContain('r')
    expect([...v.data.keys()]).toEqual(['MS_TOKENS_WORK'])
  })

  it('returns null for an account that has never signed in', () => {
    expect(loadTokens('nobody', fakeVault() as never)).toBeNull()
  })

  it('returns null rather than throwing on a corrupt entry', () => {
    // A half-written or hand-edited vault entry should send the owner back
    // through sign-in, not take the process down mid-turn.
    expect(loadTokens('work', fakeVault({ MS_TOKENS_WORK: 'not json' }) as never)).toBeNull()
  })

  it('returns null when the entry is json but not tokens', () => {
    expect(loadTokens('work', fakeVault({ MS_TOKENS_WORK: '{"hello":1}' }) as never)).toBeNull()
  })
})

describe('clearTokens', () => {
  it('removes the entry, so revoking is a real thing the owner can do', () => {
    const v = fakeVault()
    saveTokens('work', TOK, v as never)
    expect(clearTokens('work', v as never)).toBe(true)
    expect(loadTokens('work', v as never)).toBeNull()
  })

  it('is false when there was nothing to clear', () => {
    expect(clearTokens('work', fakeVault() as never)).toBe(false)
  })
})

describe('listAuthedAccounts', () => {
  it('names the accounts that have signed in, and nothing else in the vault', () => {
    const v = fakeVault({ OPENAI_API_KEY: 'x', MS_TOKENS_WORK: '{}', MS_TOKENS_HOME: '{}' })
    expect(listAuthedAccounts(v as never).sort()).toEqual(['HOME', 'WORK'])
  })

  it('is empty on a fresh install', () => {
    expect(listAuthedAccounts(fakeVault() as never)).toEqual([])
  })
})
