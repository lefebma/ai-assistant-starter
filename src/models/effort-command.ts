/**
 * /effort (card #272): show and set how hard the assistant thinks before
 * answering, for one chat.
 *
 * The same logic serves Telegram, Teams and the web chat; callers own where
 * the choice is stored (app_state for a chat, the conversation row on the
 * web). Only the levels the chat's current model accepts are offered. A
 * stored choice the model cannot use is kept but not sent (see agent.ts),
 * so it comes back when the chat switches to a model that has it.
 *
 * Button labels say "effort" so a click is never mistaken for an agent's own
 * button, and they need no per-menu memory: a click on an old menu still
 * means the same level.
 */
import { describeDefault, listModelChoices } from './catalog.js'
import { EFFORTS, EFFORT_LABEL, fitEffort, effortLevelsFor, type Effort } from './effort.js'
import { resolveTurnRuntime } from '../runtime/index.js'
import { defaultEffort } from '../web/defaults.js'

const BUTTON: Record<Effort | '', string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra high effort',
  '': 'Default effort',
}

/** The level a /effort button means, or undefined if the label is not one. */
export function effortForClick(label: string): Effort | '' | undefined {
  const hit = (Object.entries(BUTTON) as Array<[Effort | '', string]>).find(([, l]) => l === label.trim())
  return hit ? hit[0] : undefined
}

/** What `/effort <text>` names: a level, '' for default, or null. */
export function parseEffort(text: string): Effort | '' | null {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!t) return null
  if (t === 'default' || t === 'reset' || t === 'auto') return ''
  if (t === 'xhigh' || t === 'extrahigh' || t === 'veryhigh') return 'xhigh'
  if (t === 'med') return 'medium'
  return (EFFORTS as readonly string[]).includes(t) ? (t as Effort) : null
}

/** The model a chat's choice runs on, for replies. */
async function modelLabel(model: string | undefined): Promise<string> {
  if (!model) return describeDefault()
  try {
    const choice = (await listModelChoices({ cacheOnly: true })).find((c) => c.ref === model)
    if (choice) return choice.label
  } catch {
    /* fall through to the id */
  }
  return model.includes(':') ? model.slice(model.indexOf(':') + 1) : model
}

/** "Default" with the level it stands for, when the box says. */
function defaultText(model: string | undefined): string {
  // Only the claude runtime reads a default from its settings files.
  if (resolveTurnRuntime('chat', model).id !== 'claude') return 'Default'
  const d = defaultEffort()
  return d ? `Default (${EFFORT_LABEL[d]})` : 'Default'
}

function describe(effort: Effort | undefined, levels: Effort[], model: string | undefined): string {
  if (!effort) return defaultText(model)
  const runs = fitEffort(effort, levels)
  if (runs === effort) return EFFORT_LABEL[effort]
  return runs ? `${EFFORT_LABEL[effort]}, running as ${EFFORT_LABEL[runs]} on this model` : `${EFFORT_LABEL[effort]}, not used on this model`
}

function choicesText(levels: Effort[]): string {
  return [...levels, 'default'].join(', ')
}

export type EffortMenu = { text: string; buttons: string[]; lines: string[] }

/** The reply to `/effort` with no argument. */
export async function effortMenu(model: string | undefined, current: Effort | undefined): Promise<EffortMenu> {
  const levels = effortLevelsFor('chat', model)
  const label = await modelLabel(model)
  if (!levels.length) {
    const kept = current ? ` Your pick (${EFFORT_LABEL[current]}) comes back when you switch to a model that has one.` : ''
    return { text: `${label} has no effort setting, so /effort does not apply to it.${kept}`, buttons: [], lines: [] }
  }
  return {
    text: `Effort: ${describe(current, levels, model)}\nModel: ${label}\n\nHow hard should I think before answering? Higher takes longer and uses more of your AI budget.`,
    buttons: [...levels.map((l) => BUTTON[l]), BUTTON['']],
    lines: [...levels.map((l) => `/effort ${l}  (${EFFORT_LABEL[l]})`), '/effort default'],
  }
}

export type EffortSet = { ok: true; effort: Effort | ''; text: string } | { ok: false; text: string }

/** Set the chat's effort from `/effort <arg>` or a button's level. */
export async function setEffort(model: string | undefined, current: Effort | undefined, wanted: Effort | '' | null, typed?: string): Promise<EffortSet> {
  const levels = effortLevelsFor('chat', model)
  if (wanted === null) {
    const offer = levels.length ? choicesText(levels) : 'default'
    return { ok: false, text: `"${(typed ?? '').trim()}" is not an effort level. Pick one of: ${offer}.` }
  }
  if (wanted === '') {
    if (!current) return { ok: true, effort: '', text: 'Effort is already on the default.' }
    return { ok: true, effort: '', text: 'Effort is back on the default.' }
  }
  if (!levels.length) {
    return { ok: false, text: `${await modelLabel(model)} has no effort setting, so there is nothing to set.` }
  }
  if (!levels.includes(wanted)) {
    return { ok: false, text: `${await modelLabel(model)} does not offer ${EFFORT_LABEL[wanted]}. Pick one of: ${choicesText(levels)}.` }
  }
  if (current === wanted) return { ok: true, effort: wanted, text: `Effort is already ${EFFORT_LABEL[wanted]}.` }
  return { ok: true, effort: wanted, text: `Effort set to ${EFFORT_LABEL[wanted]}.` }
}

/**
 * A line to add to a /model reply when the chat's effort does not carry over
 * to the new model as it is. Empty when it does, or when none is set.
 */
export function effortNoteAfterSwitch(model: string | undefined, effort: Effort | undefined): string {
  if (!effort) return ''
  const levels = effortLevelsFor('chat', model)
  const runs = fitEffort(effort, levels)
  if (runs === effort) return ''
  if (!runs) return `This model has no effort setting, so your ${EFFORT_LABEL[effort]} effort is not used on it. It comes back when you switch to a model that has one.`
  return `Your ${EFFORT_LABEL[effort]} effort runs as ${EFFORT_LABEL[runs]} on this model.`
}
