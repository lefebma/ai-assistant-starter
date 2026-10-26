/**
 * The page side of card #252: which way the page dictates, putting words in
 * at the cursor, the plain-language problems, and both dictation paths driven
 * with stand-ins for the browser's recorder and speech recognition.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dictationMode,
  pickMimeType,
  insertAtCursor,
  formatElapsed,
  micProblem,
  createDictation,
  MAX_SECONDS,
  // @ts-expect-error plain ES module shipped to the browser, no type declarations
} from '../public/app/dictation.js'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import * as api from '../public/app/api.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const html = readFileSync(join(APP, 'index.html'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

afterEach(() => {
  vi.unstubAllGlobals()
})

class FakeRecorder extends EventTarget {
  static supported = ['audio/webm;codecs=opus', 'audio/webm']
  static last: FakeRecorder | null = null
  static isTypeSupported(t: string) {
    return FakeRecorder.supported.includes(t)
  }
  state = 'inactive'
  mimeType: string
  constructor(public stream: unknown, public options: { mimeType?: string } = {}) {
    super()
    this.mimeType = options.mimeType || 'audio/webm'
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    const e = new Event('dataavailable') as Event & { data: Blob }
    e.data = new Blob(['spoken audio'], { type: this.mimeType })
    this.dispatchEvent(e)
    this.dispatchEvent(new Event('stop'))
  }
}

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true } }]
  return { tracks, getTracks: () => tracks }
}

/** A window with a recorder and microphone, plus a manual clock for the limit. */
function boxWindow(opts: { deny?: string } = {}) {
  const stream = fakeStream()
  const intervals: Array<() => void> = []
  const win = {
    navigator: {
      language: 'en-CA',
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          if (opts.deny) throw Object.assign(new Error('denied'), { name: opts.deny })
          return stream
        }),
      },
    },
    MediaRecorder: FakeRecorder,
    Blob,
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval: () => {},
  }
  return { win, stream, intervals }
}

class FakeRecognition extends EventTarget {
  static last: FakeRecognition | null = null
  static deny = ''
  continuous = false
  interimResults = false
  lang = ''
  constructor() {
    super()
    FakeRecognition.last = this
  }
  start() {
    queueMicrotask(() => {
      if (FakeRecognition.deny) {
        this.dispatchEvent(Object.assign(new Event('error'), { error: FakeRecognition.deny }))
        this.dispatchEvent(new Event('end'))
      } else this.dispatchEvent(new Event('start'))
    })
  }
  stop() {
    queueMicrotask(() => this.dispatchEvent(new Event('end')))
  }
  abort() {
    this.stop()
  }
  hear(results: Array<[string, boolean]>) {
    const list = results.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal }))
    this.dispatchEvent(Object.assign(new Event('result'), { results: list, resultIndex: 0 }))
  }
}

function browserWindow() {
  return { navigator: { language: 'en-CA' }, webkitSpeechRecognition: FakeRecognition, setInterval: () => 0, clearInterval: () => {} }
}

describe('dictationMode', () => {
  const recorder = { navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: FakeRecorder }
  it('uses the box when it transcribes and the browser can record', () => {
    expect(dictationMode({ transcribe: true }, recorder)).toBe('box')
  })
  it('falls back to the browser when the box cannot transcribe', () => {
    expect(dictationMode({ transcribe: false }, { ...recorder, webkitSpeechRecognition: FakeRecognition })).toBe('browser')
    expect(dictationMode({ transcribe: false }, { navigator: {}, SpeechRecognition: FakeRecognition })).toBe('browser')
  })
  it('falls back to the browser when it cannot record (plain http has no microphone)', () => {
    expect(dictationMode({ transcribe: true }, { navigator: {}, webkitSpeechRecognition: FakeRecognition })).toBe('browser')
  })
  it('hides the microphone when neither can', () => {
    expect(dictationMode({ transcribe: false }, recorder)).toBe('')
    expect(dictationMode({ transcribe: true }, { navigator: {} })).toBe('')
    expect(dictationMode(null, { navigator: {} })).toBe('')
  })
})

describe('pickMimeType', () => {
  it('prefers WebM, takes MP4 on Safari, and lets the browser choose otherwise', () => {
    expect(pickMimeType(FakeRecorder)).toBe('audio/webm;codecs=opus')
    expect(pickMimeType({ isTypeSupported: (t: string) => t === 'audio/mp4' })).toBe('audio/mp4')
    expect(pickMimeType({ isTypeSupported: () => false })).toBe('')
    expect(pickMimeType({})).toBe('')
    expect(pickMimeType(undefined)).toBe('')
  })
})

describe('insertAtCursor', () => {
  it('fills an empty box', () => {
    expect(insertAtCursor('', 0, ' hello there ')).toEqual({ value: 'hello there', caret: 11 })
  })
  it('appends after typed text with a space', () => {
    expect(insertAtCursor('Remind me', 9, 'to call Gus')).toEqual({ value: 'Remind me to call Gus', caret: 21 })
  })
  it('does not double a space that is already there', () => {
    expect(insertAtCursor('Remind me ', 10, 'to call Gus').value).toBe('Remind me to call Gus')
  })
  it('goes in at the cursor and keeps what follows, spaced on both sides', () => {
    const r = insertAtCursor('Call tomorrow', 4, 'Gus')
    expect(r.value).toBe('Call Gus tomorrow')
    expect(r.caret).toBe(8)
  })
  it('adds no space before punctuation that follows', () => {
    expect(insertAtCursor('Call .', 5, 'Gus').value).toBe('Call Gus.')
    expect(insertAtCursor('Call?', 4, 'Gus').value).toBe('Call Gus?')
  })
  it('keeps a new line before the cursor as the separator', () => {
    expect(insertAtCursor('First line\n', 11, 'second').value).toBe('First line\nsecond')
  })
  it('changes nothing when no words came back', () => {
    expect(insertAtCursor('typed', 5, '   ')).toEqual({ value: 'typed', caret: 5 })
  })
  it('keeps the position inside the text', () => {
    expect(insertAtCursor('abc', 99, 'x').value).toBe('abc x')
    expect(insertAtCursor('abc', -4, 'x').value).toBe('x abc')
    expect(insertAtCursor('abc', NaN, 'x').value).toBe('abc x')
  })
})

describe('formatElapsed and micProblem', () => {
  it('formats the timer', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(7400)).toBe('0:07')
    expect(formatElapsed(90_000)).toBe('1:30')
  })
  it('explains a blocked or missing microphone plainly', () => {
    expect(micProblem({ name: 'NotAllowedError' })).toMatch(/blocked/)
    expect(micProblem({ error: 'not-allowed' })).toMatch(/blocked/)
    expect(micProblem({ name: 'NotFoundError' })).toMatch(/No microphone/)
    expect(micProblem({ error: 'no-speech' })).toMatch(/Did not catch/)
    expect(micProblem({ status: 413 })).toMatch(/two minutes/)
    expect(micProblem({ status: 503 })).toMatch(/cannot turn speech into text/)
    expect(micProblem(new TypeError('fetch failed'))).toMatch(/Cannot reach/)
    expect(micProblem({})).toMatch(/did not work/)
  })
})

describe('box dictation', () => {
  it('records, stops, sends the recording, and returns the words', async () => {
    const { win, stream } = boxWindow()
    const transcribe = vi.fn(async (b: Blob) => (b.size ? 'hello from the box' : ''))
    const d = createDictation('box', { transcribe }, win)
    await d.start()
    expect(win.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(FakeRecorder.last!.options.mimeType).toBe('audio/webm;codecs=opus')
    expect(await d.stop()).toBe('hello from the box')
    expect(transcribe.mock.calls[0]![0].type).toBe('audio/webm;codecs=opus')
    // The microphone is let go of.
    expect(stream.tracks[0]!.stopped).toBe(true)
  })

  it('rejects start when permission is refused', async () => {
    const { win } = boxWindow({ deny: 'NotAllowedError' })
    const d = createDictation('box', { transcribe: vi.fn() }, win)
    await expect(d.start()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('ends itself at the two-minute limit', async () => {
    const { win, intervals } = boxWindow()
    let t = 0
    const ended = vi.fn()
    const tick = vi.fn()
    const d = createDictation('box', { transcribe: vi.fn(), ended, tick, now: () => t }, win)
    await d.start()
    t = 5000
    intervals[0]!()
    expect(tick).toHaveBeenLastCalledWith(5000)
    expect(ended).not.toHaveBeenCalled()
    t = MAX_SECONDS * 1000
    intervals[0]!()
    intervals[0]!()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith('limit')
  })

  it('passes a failed transcription on', async () => {
    const { win } = boxWindow()
    const d = createDictation('box', { transcribe: async () => { throw Object.assign(new Error('x'), { status: 503 }) } }, win)
    await d.start()
    await expect(d.stop()).rejects.toMatchObject({ status: 503 })
  })
})

describe('browser dictation', () => {
  afterEach(() => {
    FakeRecognition.deny = ''
  })

  it('shows words as they are heard and returns them all at the end', async () => {
    const heard = vi.fn()
    const d = createDictation('browser', { heard }, browserWindow())
    await d.start()
    const rec = FakeRecognition.last!
    expect(rec.continuous).toBe(true)
    expect(rec.interimResults).toBe(true)
    expect(rec.lang).toBe('en-CA')
    rec.hear([['remind me', false]])
    expect(heard).toHaveBeenLastCalledWith('remind me')
    rec.hear([['remind me', true], [' to call', false]])
    expect(heard).toHaveBeenLastCalledWith('remind me to call')
    expect(await d.stop()).toBe('remind me to call')
  })

  it('rejects start when the browser blocks the microphone', async () => {
    FakeRecognition.deny = 'not-allowed'
    const d = createDictation('browser', {}, browserWindow())
    await expect(d.start()).rejects.toMatchObject({ error: 'not-allowed' })
  })

  it('says when it stopped listening on its own', async () => {
    const ended = vi.fn()
    const d = createDictation('browser', { ended }, browserWindow())
    await d.start()
    FakeRecognition.last!.dispatchEvent(new Event('end'))
    expect(ended).toHaveBeenCalledWith('quiet')
  })

  it('reports a problem only when nothing was heard', async () => {
    const d = createDictation('browser', {}, browserWindow())
    await d.start()
    FakeRecognition.last!.dispatchEvent(Object.assign(new Event('error'), { error: 'network' }))
    await expect(d.stop()).rejects.toMatchObject({ error: 'network' })

    const d2 = createDictation('browser', {}, browserWindow())
    await d2.start()
    FakeRecognition.last!.hear([['some words', true]])
    FakeRecognition.last!.dispatchEvent(Object.assign(new Event('error'), { error: 'no-speech' }))
    expect(await d2.stop()).toBe('some words')
  })
})

describe('api.transcribe', () => {
  it('posts the recording as audio with the upload header and returns the words', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'heard this' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['x'], { type: 'audio/mp4' })
    expect(await api.transcribe(blob)).toBe('heard this')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('/api/web/dictation')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('audio/mp4')
    expect(init.headers['X-Havn-Web']).toBe('1')
    expect(init.body).toBe(blob)
  })
})

describe('the composer', () => {
  it('has a microphone next to Send, hidden until the page knows it can dictate', () => {
    const at = html.indexOf('class="composer-box"')
    const box = html.slice(at, html.indexOf('</form>', at))
    const mic = box.match(/<button[^>]*id="mic"[^>]*>/)?.[0] ?? ''
    expect(mic).toMatch(/\shidden/)
    expect(mic).toMatch(/aria-label="Dictate a message"/)
    expect(box.indexOf('id="mic"')).toBeLessThan(box.indexOf('id="send"'))
  })
  it('stops dictation on Send without sending', () => {
    const submit = js.slice(js.indexOf("$('composer').addEventListener('submit'"))
    const guard = submit.slice(0, submit.indexOf('const input'))
    expect(guard).toMatch(/if \(dictate\.phase\) \{[\s\S]*finishDictation\(\)[\s\S]*return\s*\}/)
    expect(guard).not.toMatch(/send\(/)
  })
  it('decides the path from the flag the page already loads', () => {
    expect(js).toMatch(/dictationMode\(state\.me\)/)
  })
})
