/**
 * Web routes: proactive message settings (card #262), the web app's side of
 * what the owner can also say in chat. Changes go through applyChange, like
 * the chat command, so the limits, the refusal without a calendar and the
 * replies are the same in both places.
 *
 * Primary chat only: proactive messages go to the owner's chat, so another
 * authorized chat gets 403 and the settings section stays hidden for it.
 */
import { registerWebRoutes } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { PRIMARY_CHAT_ID } from '../config.js'
import { KINDS, LIMITS, applyChange, getQuietHours, getSettings, type MessageKind, type SettingsChange } from '../proactive/settings.js'
import { discoverCalendars } from '../proactive/calendar.js'
import { listAuthedAccounts } from '../ms/store.js'
import { outlookClient } from '../email-alerts/sources.js'
import { createMapsClient } from '../maps/client.js'

const mapsReady = (): boolean => createMapsClient().mode !== 'off'

function view() {
  const s = getSettings()
  const travel = KINDS.some((k) => k.id === 'travel' && k.available)
  return {
    kinds: KINDS.filter((k) => k.available).map((k) => ({ id: k.id, label: k.label, on: s[k.id].on })),
    leadMinutes: s.briefing.leadMinutes,
    quietHours: getQuietHours(),
    // The starting address is the owner's own, shown only to the primary chat (the route checks).
    travel: travel ? { bufferMinutes: s.travel.bufferMinutes, mode: s.travel.mode, origin: s.travel.origin, mapsReady: mapsReady() } : null,
    limits: { leadMinutes: LIMITS.leadMinutes, bufferMinutes: LIMITS.bufferMinutes },
  }
}

/** Only the fields the page sends, with their types checked; the values are checked by applyChange. */
export function parseChange(b: unknown): SettingsChange | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null
  const r = b as Record<string, unknown>
  const change: SettingsChange = {}
  if (r['on'] !== undefined) {
    if (!r['on'] || typeof r['on'] !== 'object' || Array.isArray(r['on'])) return null
    const on: Partial<Record<MessageKind, boolean>> = {}
    for (const [k, v] of Object.entries(r['on'] as Record<string, unknown>)) {
      if (!KINDS.some((x) => x.id === k) || typeof v !== 'boolean') return null
      on[k as MessageKind] = v
    }
    change.on = on
  }
  if (r['leadMinutes'] !== undefined) {
    if (typeof r['leadMinutes'] !== 'number') return null
    change.leadMinutes = r['leadMinutes']
  }
  for (const f of ['bufferMinutes'] as const) {
    if (r[f] === undefined) continue
    if (typeof r[f] !== 'number') return null
    change[f] = r[f] as number
  }
  for (const f of ['mode', 'origin'] as const) {
    if (r[f] === undefined) continue
    if (typeof r[f] !== 'string') return null
    change[f] = r[f] as string
  }
  if (r['quietHours'] !== undefined) {
    const q = r['quietHours']
    if (q === null) change.quietHours = null
    else if (q && typeof q === 'object' && typeof (q as Record<string, unknown>)['start'] === 'string' && typeof (q as Record<string, unknown>)['end'] === 'string') {
      change.quietHours = { start: (q as Record<string, string>)['start']!, end: (q as Record<string, string>)['end']! }
    } else return null
  }
  return change
}

async function calendarNames(): Promise<string[]> {
  try {
    const list = await discoverCalendars({ msAccounts: () => listAuthedAccounts(), client: outlookClient })
    return list.map((c) => `${c.id} (${c.provider === 'google' ? 'Google' : 'Outlook'})`)
  } catch {
    return []
  }
}

const isPrimary = (chatId: string): boolean => PRIMARY_CHAT_ID !== '' && chatId === PRIMARY_CHAT_ID

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/proactive$/,
    auth: true,
    handler(ctx) {
      if (!isPrimary(ctx.chatId)) return sendError(ctx.res, 403, 'primary_only')
      sendJson(ctx.res, 200, view())
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/proactive$/,
    auth: true,
    async handler(ctx) {
      if (!isPrimary(ctx.chatId)) return sendError(ctx.res, 403, 'primary_only')
      let change: SettingsChange | null
      try {
        change = parseChange(await readJsonCapped(ctx.req))
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      if (!change) return sendError(ctx.res, 400, 'bad_request')
      // Calendars are looked up only when something is being turned on.
      const turningOn = Object.values(change.on ?? {}).some(Boolean)
      const r = applyChange(getSettings(), change, { calendars: turningOn ? await calendarNames() : [], mapsReady: mapsReady() })
      sendJson(ctx.res, 200, { ok: r.ok, message: r.message, ...view() })
    },
  },
])
