/**
 * Optional external-dashboard integration paths.
 *
 * Env-driven with NO defaults: when unset, the integration is off and every
 * consumer no-ops. The public product must never assume a personal machine
 * layout (enforced by tests/no-personal-paths.test.ts).
 *
 *   DASHBOARD_DIR       - where the dashboard app keeps its skills registry
 *   DASHBOARD_DATA_DIR  - where the assistant writes activity/run/job files
 */
import { resolve } from 'node:path'
import { readEnvFile } from '../env.js'

function fromEnv(key: string): string | null {
  return process.env[key]?.trim() || readEnvFile()[key]?.trim() || null
}

export function dashboardFile(name: string): string | null {
  const dir = fromEnv('DASHBOARD_DIR')
  return dir ? resolve(dir, name) : null
}

export function dashboardDataFile(name: string): string | null {
  const dir = fromEnv('DASHBOARD_DATA_DIR')
  return dir ? resolve(dir, name) : null
}
