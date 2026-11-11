/**
 * What the box knows about how it is used, for choosing a tip. Local only: no
 * network, no model. A source that cannot be read counts as not connected, so
 * the worst outcome is a tip held back or one about connecting something.
 */
import { getSettings as getAlertSettings } from '../email-alerts/store.js'
import { getSettings as getProactiveSettings } from '../proactive/settings.js'
import { getAllTasks, getDb } from '../db.js'
import { liveDecisions } from '../memory/decisions.js'
import { connectionDeps } from '../web/connections.js'
import { voiceCapabilities } from '../voice.js'
import { OPENAI_API_KEY } from '../config.js'
import { isManagedAi } from '../ai-limit.js'
import type { TipContext } from './catalog.js'

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export async function tipContext(chatId: string): Promise<TipContext> {
  const conn = connectionDeps()
  const gmail = (await conn.gmailAccounts().catch(() => null)) ?? []
  const outlook = attempt(() => conn.outlookAccounts(), [])
  const imap = attempt(() => conn.imapAccounts(), [])
  const proactive = getProactiveSettings()
  return {
    mail: gmail.length + outlook.length + imap.length > 0,
    calendar: gmail.length + outlook.length > 0,
    gmailAccounts: gmail.length,
    briefingOn: proactive.briefing.on,
    travelOn: proactive.travel.on,
    timingOn: proactive.timing.on,
    emailAlertsOn: attempt(() => getAlertSettings().enabled, false),
    scheduledTasks: attempt(() => getAllTasks().length, 0),
    decisions: attempt(() => liveDecisions(chatId).length, 0),
    voiceReplies: attempt(() => voiceCapabilities().tts, false),
    importedProjects: attempt(
      () => !!getDb().prepare("SELECT 1 FROM projects WHERE chat_id = ? AND source LIKE 'claude:%' LIMIT 1").get(chatId),
      false,
    ),
    importedFromChatGPT: attempt(
      () => !!getDb().prepare("SELECT 1 FROM projects WHERE chat_id = ? AND source LIKE 'chatgpt:%' LIMIT 1").get(chatId),
      false,
    ),
    ownOpenAiKey: !!OPENAI_API_KEY && !attempt(() => isManagedAi(), true),
  }
}
