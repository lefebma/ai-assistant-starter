import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = readFileSync(join(REPO, 'public', 'voice.html'), 'utf-8')
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + '<script>'.length, PAGE.lastIndexOf('</script>'))

/**
 * The last fix for this page passed a suite that only checked the page
 * contained the right words, and then failed on the first iPhone that opened
 * it. These tests run the page's own code against the rule that broke it.
 *
 * iOS grants playback to an ELEMENT, not to a page: an element whose play()
 * was called inside a user gesture may be replayed from an async chain
 * forever after, and an element that has never had that is refused. Desktop
 * browsers are lenient about gesture history, which is why a Mac heard every
 * reply while a phone heard none of them.
 */
let inGesture = false
function gesture<T>(fn: () => T): T {
  inGesture = true
  try { return fn() } finally { inGesture = false }
}

class FakeAudio {
  src = ''
  preload = ''
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  /** Once true, stays true: the iOS grant is per element and permanent. */
  permitted = false
  played: string[] = []
  paused = 0

  play(): Promise<void> {
    if (inGesture) this.permitted = true
    if (!this.permitted) return Promise.reject(new Error('NotAllowedError'))
    this.played.push(this.src)
    // Real playback ends, and speak() only resolves when it does.
    queueMicrotask(() => { this.onended?.() })
    return Promise.resolve()
  }

  pause(): void { this.paused += 1 }
}

function stubElement(): any {
  const el: any = {
    textContent: '', innerHTML: '', value: '', title: '', className: '',
    disabled: false, removed: false, style: {} as Record<string, string>,
    children: [] as any[], selectedOptions: [] as any[],
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(type: string, fn: (e: unknown) => void) {
      (el.listeners[type] ??= []).push(fn)
    },
    removeEventListener() {},
    appendChild(child: any) { el.children.push(child); return child },
    prepend(child: any) { el.children.unshift(child); return child },
    remove() { el.removed = true },
    click() { for (const fn of el.listeners['click'] ?? []) fn({}) },
  }
  return el
}

interface Page {
  speak: (text: string) => Promise<void>
  unlockAudio: () => void
  startRecording: () => Promise<void>
  stopSpeaking: () => void
  player: FakeAudio
  transcript: any
  session: { type: string }
  speakCalls: string[]
}

/** Runs public/voice.html's script against stubs and hands back its internals. */
function loadPage(opts: { sinkSupported?: boolean } = {}): Page {
  const elements = new Map<string, any>()
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, stubElement())
      return elements.get(id)
    },
    createElement: () => stubElement(),
    addEventListener() {},
  }

  const session = { type: 'auto' }
  const navigator = {
    audioSession: session,
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => [],
      addEventListener() {},
    },
  }

  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }

  const speakCalls: string[] = []
  const fetchStub = async (url: string, init: any) => {
    if (String(url).includes('/api/speak')) {
      speakCalls.push(JSON.parse(init.body).text)
      return { ok: true, status: 200, blob: async () => ({ size: 64, type: 'audio/mpeg' }) }
    }
    return { ok: true, status: 200, json: async () => ({ text: '' }) }
  }

  let blobs = 0
  const url = {
    createObjectURL: () => `blob:reply-${++blobs}`,
    revokeObjectURL: () => {},
  }

  // Safari on iOS has no setSinkId at all, which is the shape that matters here.
  const HTMLMediaElement = opts.sinkSupported
    ? { prototype: { setSinkId() {} } }
    : undefined

  class MediaRecorder {
    static isTypeSupported() { return true }
    state = 'recording'
    ondataavailable: unknown = null
    onstop: unknown = null
    constructor(public stream: unknown, public opts: unknown) {}
    start() {}
    stop() {}
  }

  let captured: Page | null = null
  const run = new Function(
    'window', 'document', 'navigator', 'localStorage', 'fetch', 'Audio', 'URL',
    'HTMLMediaElement', 'MediaRecorder', '__expose',
    `${SCRIPT}\n__expose({ speak, unlockAudio, startRecording, stopSpeaking, player, transcript })`,
  )
  run(
    { location: { search: '?token=test-token' } },
    document, navigator, localStorage, fetchStub, FakeAudio, url,
    HTMLMediaElement, MediaRecorder,
    (internals: any) => { captured = { ...internals, session, speakCalls } },
  )

  if (!captured) throw new Error('page script did not expose its internals')
  return captured
}

describe('the voice page, played the way an iPhone plays it', () => {
  it('speaks the reply, given only the gesture the page actually gets', async () => {
    const page = loadPage()

    // The single gesture available: the tap that ends recording. Priming on the
    // tap that STARTS it would leave the capture recording silence.
    gesture(() => page.unlockAudio())

    // Everything after this is an async chain. No gesture is in scope, which is
    // the whole difficulty.
    await page.speak('the assistant answering')

    expect(page.speakCalls).toEqual(['the assistant answering'])
    expect(page.player.played).toEqual([expect.stringContaining('data:audio/wav'), 'blob:reply-1'])
  })

  it('speaks every later reply too, without another gesture', async () => {
    const page = loadPage()
    gesture(() => page.unlockAudio())

    await page.speak('first')
    await page.speak('second')
    await page.speak('third')

    expect(page.player.played.slice(1)).toEqual(['blob:reply-1', 'blob:reply-2', 'blob:reply-3'])
  })

  it('offers a tap when it was never primed, instead of going silent', async () => {
    const page = loadPage()

    // No gesture ever reached the audio element: iOS refuses, and a phone has
    // no console to say so in.
    await page.speak('a reply nobody can hear')

    expect(page.player.played).toEqual([])
    const offer = page.transcript.children[0]
    expect(offer.textContent).toContain('Tap here to hear')

    // Tapping it is a gesture, so this time it plays.
    gesture(() => offer.click())
    await Promise.resolve()
    expect(page.player.played).toEqual(['blob:reply-1'])
  })

  it('holds the audio for that tap rather than revoking it out from under itself', async () => {
    const page = loadPage()
    await page.speak('blocked')

    const offer = page.transcript.children[0]
    const src = page.player.src
    gesture(() => offer.click())
    await Promise.resolve()

    expect(page.player.played).toEqual([src])
  })

  it('asks for a playback session before speaking, so the ringer switch does not mute it', async () => {
    const page = loadPage()
    gesture(() => page.unlockAudio())

    await page.speak('heard through a silent switch')
    expect(page.session.type).toBe('playback')
  })

  it('hands the session back before capture, or the mic records silence', async () => {
    const page = loadPage()
    gesture(() => page.unlockAudio())
    await page.speak('anything')
    expect(page.session.type).toBe('playback')

    await page.startRecording()
    expect(page.session.type).toBe('play-and-record')
  })

  it('still plays where the browser can choose an output device', async () => {
    const page = loadPage({ sinkSupported: true })
    gesture(() => page.unlockAudio())

    await page.speak('on a desktop')
    expect(page.player.played).toContain('blob:reply-1')
  })
})
