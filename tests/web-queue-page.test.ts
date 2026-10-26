/**
 * The page side of card #250: which messages run at once, the queue labels,
 * the client's handling of a queued answer and of a followed conversation,
 * and the static rules (Send stays on mid-reply, queued messages look queued).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import { runsNow, newClientId, queueLabel } from '../public/app/queue.js'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import * as api from '../public/app/api.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const css = readFileSync(join(APP, 'app.css'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

afterEach(() => {
  vi.unstubAllGlobals()
})

function sse(events: Array<[string, unknown]>): Response {
  const body = events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('runsNow', () => {
  it('runs /cancel, /steer and /secret at once, and nothing else', () => {
    expect(runsNow('/cancel')).toBe(true)
    expect(runsNow('  /steer go left ')).toBe(true)
    expect(runsNow('/cancel@umi_bot')).toBe(true)
    expect(runsNow('/CANCEL')).toBe(true) // the router matches commands without regard to case
    expect(runsNow('/secret set OPENAI_API_KEY')).toBe(true) // may carry a key: never queued
    expect(runsNow('/chatid')).toBe(false)
    expect(runsNow('/cancelled')).toBe(false)
    expect(runsNow('please /cancel')).toBe(false)
    expect(runsNow('[button_click]: Send')).toBe(false)
    expect(runsNow('')).toBe(false)
  })
})

describe('newClientId and queueLabel', () => {
  it('names every message differently', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClientId()))
    expect(ids.size).toBe(50)
  })

  it('says where a message stands in line', () => {
    expect(queueLabel({ state: 'sending' }, 0)).toBe('Sending...')
    expect(queueLabel({ state: 'queued' }, 0)).toBe('Queued, runs next')
    expect(queueLabel({ state: 'queued' }, 1)).toBe('Queued, 2nd in line')
    expect(queueLabel({ state: 'queued' }, 2)).toBe('Queued, 3rd in line')
    expect(queueLabel({ state: 'queued' }, 10)).toBe('Queued, 11th in line')
  })
})

describe('api.streamChat and api.follow', () => {
  it('hands a queued answer to onItem and sends the clientId', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: { id: 7, state: 'queued', text: 'B' } }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onItem = vi.fn()
    const onDone = vi.fn()
    expect(await api.streamChat('c1', 'B', { onItem, onDone }, { clientId: 'k1' })).toBe(true)
    expect(onItem).toHaveBeenCalledWith({ id: 7, state: 'queued', text: 'B' })
    expect(onDone).not.toHaveBeenCalled()
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({ text: 'B', clientId: 'k1' })
  })

  it('streams a reply that starts at once, with the stored user message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([['user', { message: { id: 3 } }], ['delta', { text: 'hi' }], ['done', { cancelled: false }]])))
    const seen: string[] = []
    const ok = await api.streamChat('c1', 'A', {
      onUser: (m: any) => seen.push('user ' + m.id),
      onDelta: (t: string) => seen.push('delta ' + t),
      onDone: () => seen.push('done'),
    })
    expect(ok).toBe(true)
    expect(seen).toEqual(['user 3', 'delta hi', 'done'])
  })

  it('follows several turns until idle', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/web/conversations/c1/stream')
      return sse([
        ['start', { item: { id: 1, text: 'A' } }],
        ['delta', { text: 'so far' }],
        ['done', { cancelled: false }],
        ['start', { item: { id: 2, text: 'B' } }],
        ['done', { cancelled: true }],
        ['idle', {}],
      ])
    }))
    const seen: string[] = []
    const ended = await api.follow('c1', {
      onStart: (q: any) => seen.push('start ' + q.text),
      onDelta: (t: string) => seen.push('delta ' + t),
      onDone: (d: any) => seen.push(d.cancelled ? 'stopped' : 'done'),
      onIdle: () => seen.push('idle'),
    })
    expect(ended).toBe(true)
    expect(seen).toEqual(['start A', 'delta so far', 'done', 'start B', 'stopped', 'idle'])
  })

  it('reports a follow cut off before idle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([['start', { item: { id: 1 } }], ['delta', { text: 'x' }]])))
    expect(await api.follow('c1', {})).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
    expect(await api.follow('c1', {})).toBe(false)
  })
})

describe('the page', () => {
  it('keeps Send usable while a reply is written', () => {
    expect(js).not.toMatch(/\$\('send'\)\.disabled/)
    expect(js).not.toMatch(/state\.running/)
    expect(js).toMatch(/enqueue\(convId, text, tray, body\)/)
  })

  it('shows waiting messages as queued, with edit and remove', () => {
    expect(js).toMatch(/class: 'msg user queued'/)
    expect(js).toMatch(/text: 'Edit'/)
    expect(js).toMatch(/text: 'Remove'/)
    expect(css).toMatch(/\.msg\.queued \.msg-body \{[^}]*dashed/)
  })

  it('follows a chat with a reply in progress or messages waiting when it opens', () => {
    expect(js).toMatch(/if \(r\.running \|\| \(r\.queue && r\.queue\.length\)\) follow\(id\)/)
  })
})
