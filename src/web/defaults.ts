/**
 * What "Default" means for the web app's Model and Effort pickers, so the page
 * can mark the real default in each list instead of a bare "Default".
 *
 * Model: the runtime's configured model (AGENT_MODEL).
 * Effort: when a turn sends none, the Agent SDK uses the
 * effortLevel from the settings files it loads (project local, project, then
 * the user's ~/.claude/settings.json), so read the same files in that order.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

/** 'claude-sonnet-5-5' or 'sonnet' -> 'sonnet'. Null for anything unrecognised. */
export function modelAlias(nameOrId: string | undefined): (typeof MODEL_ALIASES)[number] | null {
  const n = (nameOrId ?? '').toLowerCase()
  return MODEL_ALIASES.find((a) => n.includes(a)) ?? null
}

function readEffortLevel(file: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { effortLevel?: unknown }).effortLevel
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** The effort the SDK applies when none is sent, or null when no settings file says. */
export function defaultEffort(root: string = PROJECT_ROOT, home: string = homedir()): (typeof EFFORT_LEVELS)[number] | null {
  const found =
    readEffortLevel(join(root, '.claude', 'settings.local.json')) ??
    readEffortLevel(join(root, '.claude', 'settings.json')) ??
    readEffortLevel(join(home, '.claude', 'settings.json'))
  return (EFFORT_LEVELS as readonly string[]).includes(found ?? '') ? (found as (typeof EFFORT_LEVELS)[number]) : null
}

export function pickerDefaults(chatOverride: string | undefined, pinnedModel: string, root?: string, home?: string) {
  return {
    model: modelAlias(chatOverride) ?? modelAlias(pinnedModel),
    effort: defaultEffort(root, home),
  }
}
