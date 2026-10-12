/**
 * Writing an install's configuration from a finished set of answers. Shared by
 * the terminal wizard (scripts/setup.ts) and the web setup (src/setup/web), so
 * the two can never write different files for the same answers.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyPlan } from './execute.js'
import { buildEnvContent, buildSkillPlan, installedSkillsList, type Answers } from './plan.js'

/** Platform values the questions collect but the env template leaves blank. */
export interface PlatformCredentials {
  botToken?: string
  chatId?: string
  teamsAppId?: string
  teamsAppSecret?: string
  teamsTenantId?: string
}

/** The .env for these answers, with the platform values filled in. Pure. */
export function renderEnv(answers: Answers, creds: PlatformCredentials = {}): string {
  const fill = (env: string, name: string, value: string | undefined): string =>
    value ? env.replace(new RegExp(`^${name}=$`, 'm'), () => `${name}=${value}`) : env
  let env = buildEnvContent(answers)
  env = fill(env, 'TELEGRAM_BOT_TOKEN', creds.botToken)
  env = fill(env, 'ALLOWED_CHAT_ID', creds.chatId)
  env = fill(env, 'TEAMS_APP_ID', creds.teamsAppId)
  env = fill(env, 'TEAMS_APP_SECRET', creds.teamsAppSecret)
  env = fill(env, 'TEAMS_TENANT_ID', creds.teamsTenantId)
  return env
}

export interface WriteResult {
  /** Human summary of the skills installed. */
  installed: string
  notes: string[]
  skipped: string[]
  /** False when a .env already existed and was left alone. */
  envWritten: boolean
}

/**
 * Skills, CLAUDE.md, .env and the working directories. Never overwrites an
 * existing .env: a re-run must not wipe a working install's credentials.
 */
export function writeConfiguration(answers: Answers, creds: PlatformCredentials, projectRoot: string, home: string): WriteResult {
  const result = applyPlan(buildSkillPlan(answers, home), projectRoot)
  const envPath = resolve(projectRoot, '.env')
  const envWritten = !existsSync(envPath)
  if (envWritten) writeFileSync(envPath, renderEnv(answers, creds), { mode: 0o600 })
  for (const dir of ['projects', 'store', 'logs', 'workspace/uploads']) {
    mkdirSync(resolve(projectRoot, dir), { recursive: true })
  }
  return { installed: installedSkillsList(answers), notes: result.notes, skipped: result.skipped, envWritten }
}
