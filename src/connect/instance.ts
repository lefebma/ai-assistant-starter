/**
 * The running box's ConnectFlow: a lazily built singleton from config.
 * Kept apart from the HTTP route so bot.ts can import it without a cycle
 * (http-server -> web -> bot).
 */
import { ConnectFlow } from './box.js'
import { googleRevoker, microsoftRevoker } from './providers.js'
import { getSecret, defaultVault } from '../vault/index.js'
import { saveTokens, loadTokens, clearTokens, listAuthedAccounts } from '../ms/store.js'

let flow: ConnectFlow | null | undefined

export function getConnectFlow(): ConnectFlow | null {
  if (flow !== undefined) return flow
  const relayUrl = getSecret('CONNECT_RELAY_URL') ?? ''
  const boxId = getSecret('CONNECT_BOX_ID') ?? ''
  const handoffKey = getSecret('CONNECT_HANDOFF_KEY') ?? ''
  if (!relayUrl.startsWith('https://') || !boxId || handoffKey.length < 32) return (flow = null)
  flow = new ConnectFlow({
    relayUrl, boxId, handoffKey,
    vault: { get: (n) => defaultVault().get(n), set: (n, v) => defaultVault().set(n, v), delete: (n) => defaultVault().delete(n) },
    msTokens: { save: saveTokens, load: loadTokens, clear: clearTokens, list: () => listAuthedAccounts() },
    revokers: { gmail: googleRevoker(), outlook: microsoftRevoker() },
  })
  return flow
}

export function resetConnectFlowForTests(): void {
  flow = undefined
}

