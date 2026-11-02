/**
 * /model (card #270): show the models this box can use and switch one chat.
 *
 * The same logic serves Telegram, Teams and the web chat. Callers own where
 * the choice is stored (app_state for a chat, the conversation row on the
 * web) and clearing the session when the switch moves the chat to the other
 * runtime, whose session store is separate.
 */
import { listModelChoices, matchChoice, type CatalogDeps, type ModelChoice } from './catalog.js'
import { runtimeIdFor } from '../runtime/index.js'

/** The menu last shown per chat or conversation: button label -> ref. */
const menus = new Map<string, Map<string, string>>()

export type ModelMenu = { text: string; buttons: string[]; lines: string[] }

function currentChoice(choices: ModelChoice[], current: string | undefined): ModelChoice | undefined {
  return choices.find((c) => c.ref === (current ?? ''))
}

/** Labels made unique so a click maps back to one choice. */
function uniqueLabels(choices: ModelChoice[]): Array<{ label: string; choice: ModelChoice }> {
  const seen = new Map<string, number>()
  return choices.map((choice) => {
    const n = (seen.get(choice.label) ?? 0) + 1
    seen.set(choice.label, n)
    return { label: n === 1 ? choice.label : `${choice.label} (${n})`, choice }
  })
}

/**
 * The menu for `/model` with no argument. `menuKey` is the chat (Telegram,
 * Teams) or `web:<conversation>`; a later click on one of its buttons is
 * read back with takeModelClick.
 */
export async function modelMenu(menuKey: string, current: string | undefined, deps?: CatalogDeps): Promise<ModelMenu> {
  const choices = await listModelChoices(deps)
  const now = currentChoice(choices, current)
  const labelled = uniqueLabels(choices)
  menus.set(menuKey, new Map(labelled.map((l) => [l.label, l.choice.ref])))
  const head = `Model: ${now ? now.label : current}`
  if (choices.length <= 1) {
    return { text: `${head}\n\nThis assistant runs on one model only.`, buttons: [], lines: [] }
  }
  return {
    text: `${head}\n\nPick a model for this chat:`,
    buttons: labelled.map((l) => l.label),
    lines: labelled.map((l) => `/model ${l.choice.ref || 'default'}  (${l.label})`),
  }
}

/**
 * The ref a click on a /model menu meant, or undefined if the label is not a
 * model button. The last menu shown answers first; a click on an older menu,
 * or one from before a restart, is matched against today's list by its exact
 * label, so it switches the model instead of reaching the agent as a message.
 */
export async function modelForClick(menuKey: string, label: string, deps?: CatalogDeps): Promise<string | undefined> {
  const ref = menus.get(menuKey)?.get(label)
  if (ref !== undefined) return ref
  const labelled = uniqueLabels(await listModelChoices(deps))
  return labelled.find((l) => l.label === label)?.choice.ref
}

export type ModelSwitch =
  | { ok: true; choice: ModelChoice; freshSession: boolean; text: string }
  | { ok: false; text: string }

/** Switch from `current` to the choice `arg` names (a ref or part of a label). */
export async function switchModel(current: string | undefined, arg: string, deps?: CatalogDeps): Promise<ModelSwitch> {
  const choices = await listModelChoices(deps)
  const choice = matchChoice(choices, arg) ?? choices.find((c) => c.ref === arg)
  if (!choice) return { ok: false, text: `No model matches "${arg.trim()}". Send /model to see the list.` }
  return applyChoice(current, choice)
}

/** Switch to a ref from a menu click. */
export async function switchToRef(current: string | undefined, ref: string, deps?: CatalogDeps): Promise<ModelSwitch> {
  const choices = await listModelChoices(deps)
  const choice = choices.find((c) => c.ref === ref)
  if (!choice) return { ok: false, text: 'That model is no longer available. Send /model to see the list.' }
  return applyChoice(current, choice)
}

function applyChoice(current: string | undefined, choice: ModelChoice): ModelSwitch {
  if ((current ?? '') === choice.ref) return { ok: true, choice, freshSession: false, text: `Already on ${choice.label}.` }
  const freshSession = runtimeIdFor('chat', current) !== runtimeIdFor('chat', choice.ref || undefined)
  const text = freshSession
    ? `Switched to ${choice.label}. This starts a fresh conversation; what I remember carries over.`
    : `Switched to ${choice.label}.`
  return { ok: true, choice, freshSession, text }
}
