/**
 * The running box's ConnectFlow: a lazily built singleton from config.
 * Kept apart from the HTTP route so bot.ts can import it without a cycle
 * (http-server -> web -> bot).
 */
import { ConnectFlow } from './box.js'
import { GmailTokenKeeper, relayRevoker } from './gmail-token.js'
import { getSecret, defaultVault } from '../vault/index.js'
import { saveTokens, loadTokens, clearTokens, listAuthedAccounts } from '../ms/store.js'

let flow: ConnectFlow | null | undefined
let keeper: GmailTokenKeeper | null = null
let onRevoked: ((account: string) => void | Promise<void>) | undefined

/** The route module sets this, so the owner hears about a revoked Gmail grant without this module importing notify. */
export function setGmailRevokedHandler(fn: (account: string) => void | Promise<void>): void {
  onRevoked = fn
}

/** The box's Gmail token keeper, once /connect is configured. */
export function getGmailKeeper(): GmailTokenKeeper | null {
  getConnectFlow()
  return keeper
}

export function getConnectFlow(): ConnectFlow | null {
  if (flow !== undefined) return flow
  const relayUrl = getSecret('CONNECT_RELAY_URL') ?? ''
  const boxId = getSecret('CONNECT_BOX_ID') ?? ''
  const handoffKey = getSecret('CONNECT_HANDOFF_KEY') ?? ''
  if (!relayUrl.startsWith('https://') || !boxId || handoffKey.length < 32) return (flow = null)
  const vault = { get: (n: string) => defaultVault().get(n), set: (n: string, v: string) => defaultVault().set(n, v), delete: (n: string) => defaultVault().delete(n) }
  const k = new GmailTokenKeeper({ relayUrl, boxId, handoffKey, vault, onRevoked: (a) => onRevoked?.(a) })
  keeper = k
  flow = new ConnectFlow({
    relayUrl, boxId, handoffKey,
    vault,
    msTokens: { save: saveTokens, load: loadTokens, clear: clearTokens, list: () => listAuthedAccounts() },
    revokers: { gmail: relayRevoker({ relayUrl, boxId, handoffKey }) },
    onChange: async (p) => {
      if (p === 'gmail') await k.tick()
    },
  })
  return flow
}

export function resetConnectFlowForTests(): void {
  flow = undefined
  keeper = null
}

