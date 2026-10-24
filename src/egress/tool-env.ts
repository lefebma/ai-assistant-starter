/**
 * The env a run's tools get: the effect journal's run key (card #229) and,
 * when egress is enforced, the run's proxy (card #231). Both runtimes build
 * their tool env here so neither can forget one.
 */
import { RUN_KEY_ENV, currentRun } from '../assurance/effect-journal.js'
import { currentProxy, proxyEnv } from './index.js'

/** Extra env for this run's tools, empty outside a run. */
export function toolEnvExtras(): Record<string, string> {
  const run = currentRun()
  return { ...(run ? { [RUN_KEY_ENV]: run } : {}), ...proxyEnv(currentProxy()) }
}

/** The full env for a tool subprocess. */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...toolEnvExtras() }
}

/**
 * The SDK's `env` option: undefined when there is nothing to add and no lane
 * env (keep the SDK default), else the lane env (or process.env) plus extras.
 */
export function toolEnvOption<E extends Record<string, string | undefined>>(laneEnv: E | undefined): E | NodeJS.ProcessEnv | undefined {
  const extras = toolEnvExtras()
  if (!Object.keys(extras).length) return laneEnv
  return { ...(laneEnv ?? process.env), ...extras }
}
