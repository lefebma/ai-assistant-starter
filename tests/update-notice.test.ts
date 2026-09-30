import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideNotice,
  renderNotice,
  loadNoticeState,
  saveNoticeState,
  localHour,
  type NoticeInput,
  type NoticeState,
} from '../src/update/notice.js'
import { runUpdateNoticeOnce, type UpdateNoticeDeps } from '../src/update/notice-service.js'

const BASE: NoticeInput = {
  currentVersion: '1.28.0',
  latestVersion: '1.28.2',
  updateAvailable: true,
  localHour: 10,
  restartPending: false,
  state: { announced: '' },
}

describe('decideNotice', () => {
  it('announces a release the owner has not been told about', () => {
    expect(decideNotice(BASE)).toEqual({ announce: true, version: '1.28.2' })
  })

  it('says nothing twice about the same version', () => {
    const d = decideNotice({ ...BASE, state: { announced: '1.28.2' } })
    expect(d).toMatchObject({ announce: false })
    expect((d as { reason: string }).reason).toMatch(/already announced/)
  })

  it('speaks again when a newer version lands after one was announced', () => {
    const d = decideNotice({ ...BASE, latestVersion: '1.29.0', state: { announced: '1.28.2' } })
    expect(d).toEqual({ announce: true, version: '1.29.0' })
  })

  it('stays quiet overnight rather than buzzing a phone at 4am', () => {
    for (const hour of [0, 4, 7, 21, 23]) {
      expect(decideNotice({ ...BASE, localHour: hour })).toMatchObject({ announce: false })
    }
    for (const hour of [8, 12, 20]) {
      expect(decideNotice({ ...BASE, localHour: hour })).toMatchObject({ announce: true })
    }
  })

  it('does not nag someone who has already updated and owes a restart', () => {
    const d = decideNotice({ ...BASE, restartPending: true })
    expect(d).toMatchObject({ announce: false })
    expect((d as { reason: string }).reason).toMatch(/restart/)
  })

  it('says nothing when there is no update, or the check came back empty', () => {
    expect(decideNotice({ ...BASE, updateAvailable: false })).toMatchObject({ announce: false })
    expect(decideNotice({ ...BASE, latestVersion: null })).toMatchObject({ announce: false })
    expect(decideNotice({ ...BASE, latestVersion: '1.28.0' })).toMatchObject({ announce: false })
  })
})

describe('renderNotice', () => {
  const CHANGELOG = `## 1.28.2 - 2026-09-30

A hosted box stops running out of memory with nothing to show for it.

- **Fixed: a hosted box gets swap.** Long detail nobody needs in a push message.`

  it('leads with the release summary and says what to run', () => {
    const text = renderNotice('1.28.0', '1.28.2', CHANGELOG)
    expect(text).toContain('Havn 1.28.2 is available. This box is on 1.28.0.')
    expect(text).toContain('A hosted box stops running out of memory with nothing to show for it.')
    expect(text).toContain('/update apply')
    // The bullets stay behind /update check; an unprompted wall of text is one
    // nobody reads.
    expect(text).not.toContain('Long detail nobody needs')
  })

  it('still makes sense when the release has no summary line', () => {
    const text = renderNotice('1.28.0', '1.28.2', '## 1.28.2\n\n- only bullets here')
    expect(text).toContain('Havn 1.28.2 is available')
    expect(text).not.toContain('only bullets here')
  })

  it('works with no changelog at all', () => {
    expect(renderNotice('1.0.0', '1.1.0', null)).toContain('/update apply')
  })
})

describe('notice state', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'havn-notice-'))

  it('round-trips', () => {
    const path = join(dir(), 'update-notice.json')
    saveNoticeState({ announced: '1.28.2', at: '2026-09-30T12:00:00.000Z' }, path)
    expect(loadNoticeState(path).announced).toBe('1.28.2')
  })

  it('reads absent or corrupt as nothing announced, never as announced', () => {
    // Getting this wrong in the other direction silences a real release.
    expect(loadNoticeState(join(dir(), 'missing.json')).announced).toBe('')
    const bad = join(dir(), 'bad.json')
    writeFileSync(bad, 'not json')
    expect(loadNoticeState(bad).announced).toBe('')
  })
})

describe('localHour', () => {
  it('is the hour where the owner is, not where the server is', () => {
    const t = new Date('2026-09-30T02:30:00Z')
    expect(localHour(t, 'America/Toronto')).toBe(22)
    expect(localHour(t, 'UTC')).toBe(2)
  })
})

function harness(over: Partial<UpdateNoticeDeps> = {}, state: NoticeState = { announced: '' }) {
  const sent: string[] = []
  const saved: NoticeState[] = []
  const deps: UpdateNoticeDeps = {
    check: async () => ({ currentVersion: '1.28.0', latestVersion: '1.28.2', updateAvailable: true }),
    changelog: async () => '## 1.28.2\n\nA short summary.\n',
    restartPending: () => false,
    notify: async (t) => void sent.push(t),
    now: () => new Date('2026-09-30T14:00:00Z'),
    timeZone: () => 'America/Toronto',
    loadState: () => state,
    saveState: (s) => void saved.push(s),
    ...over,
  }
  return { deps, sent, saved }
}

describe('runUpdateNoticeOnce', () => {
  it('sends once and records the version so the next pass is quiet', async () => {
    const h = harness()
    expect(await runUpdateNoticeOnce(h.deps)).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('Havn 1.28.2 is available')
    expect(h.saved[0]!.announced).toBe('1.28.2')

    const again = harness({}, { announced: '1.28.2' })
    expect(await runUpdateNoticeOnce(again.deps)).toBe(false)
    expect(again.sent).toHaveLength(0)
  })

  it('keeps quiet about a failed check instead of telling the owner', async () => {
    const h = harness({ check: async () => { throw new Error('getaddrinfo ENOTFOUND github.com') } })
    expect(await runUpdateNoticeOnce(h.deps)).toBe(false)
    expect(h.sent).toHaveLength(0)
    expect(h.saved).toHaveLength(0)
  })

  it('does not mark a version announced when the message failed to send', async () => {
    // Otherwise a Telegram outage costs the owner the only notice that
    // release was ever going to get.
    const h = harness({ notify: async () => { throw new Error('429 Too Many Requests') } })
    expect(await runUpdateNoticeOnce(h.deps)).toBe(false)
    expect(h.saved).toHaveLength(0)
  })

  it('still sends when the changelog cannot be fetched', async () => {
    const h = harness({ changelog: async () => { throw new Error('404') } })
    expect(await runUpdateNoticeOnce(h.deps)).toBe(true)
    expect(h.sent[0]).toContain('/update apply')
  })

  it('holds the notice outside waking hours', async () => {
    // 06:00 in Toronto.
    const h = harness({ now: () => new Date('2026-09-30T10:00:00Z') })
    expect(await runUpdateNoticeOnce(h.deps)).toBe(false)
    expect(h.sent).toHaveLength(0)
    expect(h.saved).toHaveLength(0)
  })
})
