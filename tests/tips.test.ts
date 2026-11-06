/** The rules for when a tip goes out and which one (card #273). No clock, no chat, no model. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.hoisted(() => {
  process.env['AGENT_STORE_DIR'] = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tips-'))
})
vi.mock('../src/proactive/settings.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getQuietHours: () => quiet.value,
}))

const quiet = vi.hoisted(() => ({ value: null as { start: string; end: string } | null }))

import { getDb, initDatabase } from '../src/db.js'
import { TIPS, type Tip, type TipContext } from '../src/tips/catalog.js'
import {
  emptyState, holdPassed, holdReason, isNewer, loadState, markUsed, nextTip, recordSent, weekAllows, saveState, triedBy, updateTips,
  FIRST_TIP_HOLD_MS, MIN_GAP_MS, OWNER_IDLE_MS, REPEAT_GAP_MS, type Moment, type TipState,
} from '../src/tips/state.js'
import { tipTick, type TipDeps } from '../src/tips/service.js'
import { answerWebTip, lastOwnerMessage, noteAsked, noteOwnerActive, noteOwnerMessage, resolveTipClick, tipsCommand, webTip } from '../src/tips/control.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 10, 16, 0) // 11:00 in Toronto
const TZ = 'America/Toronto'

const CTX: TipContext = {
  mail: true, calendar: true, gmailAccounts: 1, briefingOn: false, travelOn: false, timingOn: false,
  emailAlertsOn: false, scheduledTasks: 0, decisions: 0, voiceReplies: false,
}

const MOMENT: Moment = { nowMs: NOW, localHour: 11, inQuietHours: false, busy: false, lastOwnerMs: 0 }

function tip(id: string, extra: Partial<Tip> = {}): Tip {
  return { id, since: '1.0.0', text: `${id} text`, tryIt: `${id} try`, commands: [`/${id}`], ...extra }
}
const LIST = [tip('a'), tip('b'), tip('c')]

function started(extra: Partial<TipState> = {}): TipState {
  return { ...emptyState(), startedAt: NOW - 30 * DAY, version: '1.72.0', ...extra }
}

beforeEach(() => {
  initDatabase()
  getDb().prepare('DELETE FROM app_state').run()
  quiet.value = null
})

describe('which tip', () => {
  it('goes in list order, then starts over once all have been shown', () => {
    const s = started()
    expect(nextTip(s, CTX, NOW, { tips: LIST })?.id).toBe('a')
    recordSent(s, ['a'], null, NOW - 90 * DAY, true)
    expect(nextTip(s, CTX, NOW, { tips: LIST })?.id).toBe('b')
    recordSent(s, ['b'], null, NOW - 80 * DAY, true)
    recordSent(s, ['c'], null, NOW - 70 * DAY, true)
    expect(nextTip(s, CTX, NOW, { tips: LIST })?.id).toBe('a')
  })

  it('does not bring a tip back inside thirty days, unless asked', () => {
    const s = started()
    for (const id of ['a', 'b', 'c']) recordSent(s, [id], null, NOW - REPEAT_GAP_MS + 1000, true)
    expect(nextTip(s, CTX, NOW, { tips: LIST })).toBeNull()
    expect(nextTip(s, CTX, NOW, { tips: LIST, asked: true })?.id).toBe('a')
  })

  it('skips what does not apply, and what is done or dismissed, for good', () => {
    const s = started()
    const tips = [tip('calendar', { applies: (c) => !c.calendar }), tip('b'), tip('c')]
    s.tips['b'] = { shown: 0, lastShown: 0, status: 'done' }
    s.tips['c'] = { shown: 0, lastShown: 0, status: 'dismissed' }
    expect(nextTip(s, CTX, NOW, { tips, asked: true })).toBeNull()
    expect(nextTip(s, { ...CTX, calendar: false }, NOW, { tips })?.id).toBe('calendar')
  })

  it('offers briefings with a calendar and connecting one without', () => {
    expect(nextTip(started(), { ...CTX, mail: false, calendar: false, gmailAccounts: 0 }, NOW)?.id).toBe('connect-mail')
    const s = started()
    s.tips['connect-mail'] = { shown: 0, lastShown: 0, status: 'done' }
    expect(nextTip(s, CTX, NOW)?.id).toBe('meeting-briefings')
    expect(nextTip(s, { ...CTX, briefingOn: true }, NOW)?.id).toBe('meeting-briefings')
    markUsed(s, { ...CTX, briefingOn: true })
    expect(nextTip(s, { ...CTX, briefingOn: true }, NOW)?.id).toBe('email-alerts')
  })

  it('counts a command or a matching sentence as trying it', () => {
    expect(triedBy('/a@my_bot now', LIST).map((t) => t.id)).toEqual(['a'])
    expect(triedBy('please do /a', LIST)).toEqual([])
    expect(triedBy('Turn on Email Alerts please').map((t) => t.id)).toEqual(['email-alerts'])
  })

  it('compares versions as numbers', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true)
    expect(isNewer('1.72.0', '1.72.0')).toBe(false)
    expect(isNewer('1.0.0', '')).toBe(true)
  })
})

describe('when a tip may go out', () => {
  it('is fine at a quiet moment', () => expect(holdReason(started(), MOMENT)).toBeNull())

  it.each([
    ['tips are off', started({ pace: 'off' }), MOMENT],
    ['quiet hours', started(), { ...MOMENT, inQuietHours: true }],
    ['outside the tip window', started(), { ...MOMENT, localHour: 9 }],
    ['outside the tip window', started(), { ...MOMENT, localHour: 17 }],
    ['a reply is running', started(), { ...MOMENT, busy: true }],
    ['mid-conversation', started(), { ...MOMENT, lastOwnerMs: NOW - OWNER_IDLE_MS + 1 }],
    ['already had one today', started({ sends: [NOW - MIN_GAP_MS + 1] }), MOMENT],
  ])('holds for: %s', (reason, s, m) => expect(holdReason(s, m)).toBe(reason))

  it('allows one a day at the same time of day', () => {
    expect(holdReason(started({ sends: [NOW - DAY] }), MOMENT)).toBeNull()
  })

  it('caps the week by pace, and waits two days on a new box', () => {
    const sends = [NOW - 6 * DAY, NOW - 4 * DAY]
    expect(weekAllows(started({ sends }), NOW)).toBe(true)
    expect(weekAllows(started({ sends: [...sends, NOW - DAY] }), NOW)).toBe(false)
    expect(weekAllows(started({ pace: 'less', sends: [NOW - 3 * DAY] }), NOW)).toBe(false)
    expect(weekAllows(started({ pace: 'less', sends: [NOW - 8 * DAY] }), NOW)).toBe(true)
    expect(holdPassed(started({ startedAt: NOW - FIRST_TIP_HOLD_MS + 1 }), NOW)).toBe(false)
  })
})

describe('the update tip', () => {
  it('picks at most two tips newer than the last version told', () => {
    const tips = [tip('old', { since: '1.70.0' }), tip('x', { since: '1.72.0' }), tip('y', { since: '1.73.0' }), tip('z', { since: '1.73.0' })]
    expect(updateTips(started({ version: '1.71.0' }), CTX, NOW, tips).map((t) => t.id)).toEqual(['x', 'y'])
  })
})

function deps(over: Partial<TipDeps> = {}): TipDeps & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    context: async () => CTX,
    send: async (text) => {
      sent.push(text)
      return `card-${sent.length}`
    },
    buttons: true,
    currentVersion: () => '1.72.0',
    busy: () => false,
    lastOwnerMs: () => 0,
    now: () => new Date(NOW),
    tz: TZ,
    ...over,
  }
}

describe('a tick', () => {
  it('sends nothing on the first run, nor any update tip, and uses no later version', async () => {
    const d = deps()
    expect(await tipTick(d)).toBe('first-run')
    expect(d.sent).toEqual([])
    expect(loadState().version).toBe('1.72.0')
  })

  it('sends one tip, says how to stop on the first, then waits for tomorrow', async () => {
    saveState(started())
    const d = deps()
    expect(await tipTick(d)).toBe('paced')
    expect(d.sent).toHaveLength(1)
    expect(d.sent[0]).toMatch(/^Tip: /)
    expect(d.sent[0]).toContain('/tips off')
    expect(await tipTick(d)).toBe('held')
    expect(d.sent).toHaveLength(1)
  })

  it('points at /tips hide where there are no buttons', async () => {
    saveState(started())
    const d = deps({ buttons: false })
    await tipTick(d)
    expect(d.sent[0]).toContain('/tips hide')
  })

  it('says what is new once after an update, and only once', async () => {
    saveState(started({ version: '1.71.0' }))
    const d = deps()
    expect(await tipTick(d)).toBe('update')
    expect(d.sent[0]).toMatch(/^New in 1\.72\.0:/)
    expect(d.sent[0]).toContain('/tips')
    const later = deps({ now: () => new Date(NOW + DAY) })
    await tipTick(later)
    expect(later.sent.join()).not.toContain('New in')
  })

  it('holds an update tip while the week is full, so less stays one a week', async () => {
    saveState(started({ pace: 'less', version: '1.71.0', sends: [NOW - 3 * DAY] }))
    const d = deps()
    expect(await tipTick(d)).toBe('held')
    expect(loadState().version).toBe('1.71.0')
    const later = deps({ now: () => new Date(NOW + 5 * DAY) })
    expect(await tipTick(later)).toBe('update')
  })

  it('reads the clock after the connections, so a slow read cannot pass the cutoff', async () => {
    saveState(started())
    let clock = NOW
    const d = deps({
      now: () => new Date(clock),
      context: async () => {
        clock = Date.UTC(2026, 10, 10, 22, 30) // 17:30 in Toronto
        return CTX
      },
    })
    expect(await tipTick(d)).toBe('held')
  })

  it('holds an update tip through quiet hours and sends it after', async () => {
    saveState(started({ version: '1.71.0' }))
    quiet.value = { start: '10:00', end: '12:00' }
    const d = deps()
    expect(await tipTick(d)).toBe('held')
    quiet.value = null
    expect(await tipTick(d)).toBe('update')
  })

  it('stays silent when off, through an update', async () => {
    saveState(started({ pace: 'off', version: '1.71.0' }))
    const d = deps()
    expect(await tipTick(d)).toBe('held')
    expect(d.sent).toEqual([])
    expect(loadState().pace).toBe('off')
    expect(loadState().version).toBe('1.72.0')
  })

  it('retries a send that failed rather than counting it', async () => {
    saveState(started())
    const bad = deps({ send: async () => { throw new Error('down') } })
    expect(await tipTick(bad)).toBe('failed')
    expect(loadState().sends).toEqual([])
    expect(await tipTick(deps())).toBe('paced')
  })

  it('does not write an old pace back when /tips off arrives during a tick', async () => {
    saveState(started())
    const d = deps({
      context: async () => {
        tipsCommand(true, 'off', CTX, true, NOW)
        return CTX
      },
    })
    expect(await tipTick(d)).toBe('held')
    expect(loadState().pace).toBe('off')
    expect(d.sent).toEqual([])
  })

  it('keeps a change that lands while a tip is being sent', async () => {
    saveState(started())
    const d = deps({
      send: async () => {
        tipsCommand(true, 'less', CTX, true, NOW)
        return 'card-1'
      },
    })
    expect(await tipTick(d)).toBe('paced')
    expect(loadState().pace).toBe('less')
  })

  it('marks what is already in use and leaves settings alone', async () => {
    saveState(started())
    const d = deps({ context: async () => ({ ...CTX, emailAlertsOn: true }) })
    await tipTick(d)
    expect(loadState().tips['email-alerts']?.status).toBe('done')
    expect(d.sent.join()).not.toContain('email alerts')
  })
})

describe('/tips', () => {
  it('shows the next tip and what has been seen, even when off, without using up the day', () => {
    saveState(started({ pace: 'off', tips: { 'connect-mail': { shown: 1, lastShown: NOW, status: 'done' } } }))
    const r = tipsCommand(true, '', CTX, true, NOW)
    expect(r.tipIds).toHaveLength(1)
    expect(r.text).toMatch(/^Tip: /)
    expect(r.text).toContain('Seen so far:')
    noteAsked(r.tipIds!, 'c1', NOW)
    expect(loadState().sends).toEqual([])
    expect(webTip(NOW)).toBeNull()
  })

  it('stays off once set, and changes pace', () => {
    saveState(started())
    expect(tipsCommand(true, 'off', CTX, true, NOW).text).toContain('off')
    expect(loadState().pace).toBe('off')
    tipsCommand(true, 'LESS', CTX, true, NOW)
    expect(loadState().pace).toBe('less')
    tipsCommand(true, 'on', CTX, true, NOW)
    expect(loadState().pace).toBe('normal')
  })

  it('hides the last tip, or one by number, and refuses elsewhere', async () => {
    saveState(started())
    expect(tipsCommand(false, 'off', CTX, true, NOW).text).toContain('main chat')
    await tipTick(deps())
    const shown = loadState().current!.ids[0]!
    tipsCommand(true, 'hide', CTX, true, NOW)
    expect(loadState().tips[shown]?.status).toBe('dismissed')
    expect(tipsCommand(true, 'hide 9', CTX, true, NOW).text).toContain('No tip 9')
    expect(tipsCommand(true, 'nonsense', CTX, true, NOW).text).toContain('Usage')
  })

  it('says so when everything has been tried', () => {
    saveState(started({ tips: Object.fromEntries(TIPS.map((x) => [x.id, { shown: 1, lastShown: NOW, status: 'done' as const }])) }))
    const r = tipsCommand(true, '', CTX, true, NOW)
    expect(r.tipIds).toBeUndefined()
    expect(r.text).toContain('tried everything')
  })
})

describe('answering a tip', () => {
  it('Not for me hides it for good; Got it only clears the web card', async () => {
    saveState(started())
    await tipTick(deps())
    const id = loadState().current!.ids[0]!
    expect(webTip(NOW)).not.toBeNull()
    expect(resolveTipClick(true, 'other-card', 'Got it')).toBeNull()
    expect(resolveTipClick(true, 'card-1', 'Send')).toBeNull()
    expect(resolveTipClick(false, 'card-1', 'Not for me')).toContain('main chat')
    expect(loadState().tips[id]?.status).toBeUndefined()
    expect(resolveTipClick(true, 'card-1', 'Got it')).toBe('Okay.')
    expect(webTip(NOW)).toBeNull()
    expect(loadState().tips[id]?.status).toBeUndefined()
    resolveTipClick(true, 'card-1', 'Not for me')
    expect(loadState().tips[id]?.status).toBe('dismissed')
  })

  it('the web card answers the same way and ages out', async () => {
    saveState(started())
    await tipTick(deps())
    expect(webTip(NOW + 8 * DAY)).toBeNull()
    const id = loadState().current!.ids[0]!
    answerWebTip([id], true, NOW)
    expect(loadState().tips[id]?.status).toBe('dismissed')
    expect(webTip(NOW)).toBeNull()
  })

  it('a card left open cannot answer a newer tip', async () => {
    saveState(started())
    await tipTick(deps())
    const newer = loadState().current!.ids[0]!
    answerWebTip(['an-older-tip'], true, NOW)
    expect(loadState().tips[newer]?.status).toBeUndefined()
    expect(webTip(NOW)?.ids).toEqual([newer])
  })

  it('keeps a card for as long as its buttons can be tapped', () => {
    const s = started()
    for (let i = 0; i < 150; i++) recordSent(s, ['a'], `card-${i}`, NOW, false)
    expect(s.cards.some((c) => c.card === 'card-0')).toBe(true)
  })
})

describe('noticing the owner', () => {
  it('marks a tip tried, keeps no text, and tracks only the main chat for idle time', () => {
    saveState(started())
    noteOwnerMessage(true, '/model', 1000)
    expect(lastOwnerMessage()).toBe(1000)
    expect(loadState().tips['model']?.status).toBe('done')
    noteOwnerMessage(false, 'hello', 2000)
    expect(lastOwnerMessage()).toBe(1000)
    noteOwnerActive(true, 3000)
    expect(lastOwnerMessage()).toBe(3000)
    expect(JSON.stringify(loadState())).not.toContain('hello')
  })
})
