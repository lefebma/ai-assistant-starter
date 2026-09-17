/**
 * Authenticated Microsoft Graph calls.
 *
 * The token lifecycle lives here rather than in each command, so "is this
 * token still good" is answered once and the answer is written back to the
 * vault for the next process. The scripts this replaces refreshed before
 * every request, which works and costs a round trip to a rate-limited
 * endpoint on every mail read.
 */
import { needsRefresh, refreshTokens, type FetchLike, type MsConfig, type MsTokens } from './auth.js'
import { loadTokens as defaultLoad, saveTokens as defaultSave } from './store.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'

export interface GraphClientOptions {
  config: MsConfig
  /** Which mailbox; namespaces the stored tokens. */
  account: string
  scopes: string
  fetchImpl?: FetchLike
  now?: () => number
  loadTokens?: (account: string) => MsTokens | null
  saveTokens?: (account: string, tokens: MsTokens) => void
}

function graphErrorMessage(body: unknown, status: number): string {
  const msg = (body as { error?: { message?: string } })?.error?.message
  return msg ? `Graph ${status}: ${msg}` : `Graph request failed with ${status}`
}

export class GraphClient {
  private readonly o: Required<Omit<GraphClientOptions, 'fetchImpl'>> & { fetchImpl: FetchLike }
  private tokens: MsTokens | null = null

  constructor(opts: GraphClientOptions) {
    this.o = {
      config: opts.config,
      account: opts.account,
      scopes: opts.scopes,
      fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init) as never),
      now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
      loadTokens: opts.loadTokens ?? ((a) => defaultLoad(a)),
      saveTokens: opts.saveTokens ?? ((a, t) => defaultSave(a, t)),
    }
  }

  /** A usable access token, refreshing and persisting only when needed. */
  private async accessToken(force = false): Promise<string> {
    if (!this.tokens) this.tokens = this.o.loadTokens(this.o.account)
    if (!this.tokens) {
      throw new Error(
        `No Microsoft sign-in stored for "${this.o.account}". Run ms-auth to sign in.`
      )
    }
    if (force || needsRefresh(this.tokens, this.o.now())) {
      this.tokens = await refreshTokens(
        this.o.config,
        this.o.scopes,
        this.tokens.refreshToken,
        this.o.fetchImpl,
        this.o.now()
      )
      this.o.saveTokens(this.o.account, this.tokens)
    }
    return this.tokens.accessToken
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    const token = await this.accessToken(retried)
    const res = await this.o.fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.status === 204) return {}
    const parsed = await res.json().catch(() => ({}))
    if (res.ok) return parsed
    // A 401 on a token we believed was live means it died early: revoked, a
    // password change, a policy. Worth one forced refresh, never two.
    if (res.status === 401 && !retried) return this.call(method, path, body, true)
    throw new Error(graphErrorMessage(parsed, res.status))
  }

  get(path: string): Promise<unknown> {
    return this.call('GET', path)
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.call('POST', path, body)
  }

  patch(path: string, body: unknown): Promise<unknown> {
    return this.call('PATCH', path, body)
  }
}
