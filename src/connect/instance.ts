/**
 * The running box's ConnectFlow: a lazily built singleton from config.
 * Kept apart from the HTTP route so bot.ts can import it without a cycle
 * (http-server -> web -> bot).
 */
import { ConnectFlow } from './box.js'
import { GmailTokenKeeper, relayRevoker } from './gmail-token.js'
import { getSecret, defaultVault } from '../vault/index.js'
import { saveTokens, loadTokens, clearTokens, listAuthedAccounts } from '../ms/store.js'
import { installGogShim, resolveReal } from './gog-shim.js'
import { resolveGogBin, setGogShim } from '../infra/gog-bin.js'
import { readEnvFile } from '../env.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { delimiter, join } from 'node:path'

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
  const shim = setUpGogShim()
  const vault = { get: (n: string) => defaultVault().get(n), set: (n: string, v: string) => defaultVault().set(n, v), delete: (n: string) => defaultVault().delete(n) }
  const k = new GmailTokenKeeper({ relayUrl, boxId, handoffKey, vault, shim, onRevoked: (a) => onRevoked?.(a) })
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

/**
 * Put the gog wrapper first: on PATH for the agent's shell, and through
 * resolveGogBin for the box's own calls. The real gog is resolved before the
 * wrapper exists, so the wrapper can never find itself. False if it could not
 * be installed (Windows, no gog): the keeper then uses the single-token
 * fallback.
 */
function setUpGogShim(): boolean {
  try {
    const dir = join(STORE_DIR, 'connect-bin')
    const real = resolveReal(resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) }), process.env.PATH ?? '', undefined, dir)
    if (!real) return false
    const path = installGogShim(dir, real, process.execPath)
    if (!path) return false
    setGogShim(path)
    const rest = (process.env.PATH ?? '').split(delimiter).filter((d) => d && d !== dir)
    process.env.PATH = [dir, ...rest].join(delimiter)
    return true
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : 'error' }, 'connect: could not install the gog wrapper')
    return false
  }
}

export function resetConnectFlowForTests(): void {
  setGogShim(undefined)
  flow = undefined
  keeper = null
}

