// Dictation from the chat box's microphone (card #252). The box transcribes
// when it can (the same engine as Telegram voice notes): the page records,
// sends the recording, and gets the words back at the end. When the box
// cannot, the browser's own speech recognition does it, with the words
// showing as they are heard. Nothing here touches the page, so app.js wires
// it up and the tests drive it with stand-ins for the browser.

/** Recording stops here and the words so far land in the box. The box refuses much more than this. */
export const MAX_SECONDS = 120

// In order of preference. Chrome and Firefox record WebM, Safari MP4.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

/** The first recording format this browser supports, or '' to let it choose. */
export function pickMimeType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return ''
  return TYPES.find((t) => {
    try {
      return Recorder.isTypeSupported(t)
    } catch {
      return false
    }
  }) || ''
}

export function speechRecognizer(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

/**
 * Which way this page dictates: 'box' when the box transcribes and the browser
 * can record, 'browser' when only the browser can listen, '' when neither (the
 * microphone stays hidden). A page reached over plain http has no microphone
 * at all, which lands here as ''.
 */
export function dictationMode(me, win = globalThis) {
  const nav = win.navigator
  const canRecord = !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && win.MediaRecorder)
  if (me && me.transcribe && canRecord) return 'box'
  if (speechRecognizer(win)) return 'browser'
  return ''
}

/**
 * Put dictated words into the box at `pos` without touching what is there,
 * adding a space on either side where the words would otherwise run together.
 * Returns the new text and where the cursor goes (just after the words).
 */
export function insertAtCursor(value, pos, words) {
  const text = (words || '').trim()
  const at = Math.max(0, Math.min(Number.isFinite(pos) ? pos : value.length, value.length))
  if (!text) return { value, caret: at }
  const before = value.slice(0, at)
  const after = value.slice(at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^[\s.,;:!?)\]}]/.test(after) ? ' ' : ''
  const head = before + lead + text
  return { value: head + trail + after, caret: head.length }
}

/** 0:07, 1:30. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/**
 * A plain sentence for anything that stops dictation. Covers getUserMedia
 * errors (by name), speech recognition errors (by code) and the box's answers.
 */
export function micProblem(err) {
  const name = (err && (err.name || err.error || err.code)) || ''
  const status = err && err.status
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'not-allowed' || name === 'service-not-allowed') {
    return 'The microphone is blocked for this page. Allow it in your browser\'s settings for this site, then tap the microphone again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'audio-capture') {
    return 'No microphone was found. Check that one is connected and turned on.'
  }
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app. Close that app and try again.'
  if (name === 'no-speech') return 'Did not catch any words. Try again a little closer to the microphone.'
  if (name === 'network') return 'Your browser needs an internet connection to turn speech into text. Try again once you are online.'
  if (name === 'language-not-supported') return 'Your browser cannot take dictation in this language.'
  if (status === 413) return 'That recording is too long. Keep it under two minutes.'
  if (status === 429) return 'Still working on your last recording. Try again in a moment.'
  if (status === 504) return 'Turning that recording into text took too long. Try again, or type your message.'
  if (status === 503) return 'Your assistant cannot turn speech into text right now. Type your message instead.'
  if (err instanceof TypeError) return 'Cannot reach your assistant. Check your connection.'
  return 'Dictation did not work. Try again, or type your message.'
}

/**
 * One dictation, start to finish. `mode` is what dictationMode() said.
 *
 * hooks: transcribe(blob) -> words (box path), heard(words) for live words
 * (browser path), tick(ms) while listening, ended() when listening stops on
 * its own (the two-minute limit, the browser giving up, or an error), and
 * now() for tests.
 *
 * start() resolves once listening, or rejects (permission refused, no
 * microphone). stop() resolves to the words; it rejects only when nothing was
 * heard because of a problem. cancel() throws everything away.
 */
export function createDictation(mode, hooks, win = globalThis) {
  return mode === 'box' ? boxDictation(hooks, win) : browserDictation(hooks, win)
}

function ticker(hooks, win) {
  const now = hooks.now || (() => Date.now())
  const began = now()
  let limited = false
  const id = win.setInterval(() => {
    const ms = now() - began
    if (hooks.tick) hooks.tick(ms)
    if (ms >= MAX_SECONDS * 1000 && !limited) {
      limited = true
      if (hooks.ended) hooks.ended('limit')
    }
  }, 250)
  return () => win.clearInterval(id)
}

function boxDictation(hooks, win) {
  let stream = null
  let rec = null
  let chunks = []
  let stopped = null
  let stopTick = () => {}
  const release = () => {
    stopTick()
    if (stream) for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  return {
    async start() {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType(win.MediaRecorder)
      try {
        rec = new win.MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 })
      } catch (err) {
        release()
        throw err
      }
      rec.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) chunks.push(e.data)
      })
      stopped = new Promise((resolve) => rec.addEventListener('stop', () => resolve(), { once: true }))
      // A recorder can fail mid-way (the microphone unplugged): end like a stop.
      rec.addEventListener('error', () => {
        if (hooks.ended) hooks.ended('error')
      })
      rec.start()
      stopTick = ticker(hooks, win)
    },
    async stop() {
      stopTick()
      if (rec && rec.state !== 'inactive') rec.stop()
      if (stopped) await stopped
      release()
      const type = (rec && rec.mimeType) || pickMimeType(win.MediaRecorder) || 'audio/webm'
      const blob = new win.Blob(chunks, { type })
      chunks = []
      if (!blob.size) return ''
      return (await hooks.transcribe(blob)) || ''
    },
    cancel() {
      try {
        if (rec && rec.state !== 'inactive') rec.stop()
      } catch {
        // already stopped
      }
      chunks = []
      release()
    },
  }
}

function browserDictation(hooks, win) {
  const Recognizer = speechRecognizer(win)
  let rec = null
  let words = ''
  let problem = null
  let ended = null
  let stopTick = () => {}
  let stopping = false
  return {
    start() {
      return new Promise((resolve, reject) => {
        let listening = false
        rec = new Recognizer()
        rec.continuous = true
        rec.interimResults = true
        rec.lang = (win.navigator && win.navigator.language) || 'en-US'
        rec.addEventListener('start', () => {
          listening = true
          stopTick = ticker(hooks, win)
          resolve()
        }, { once: true })
        rec.addEventListener('result', (e) => {
          // Every result so far, final and not, in order: the live words.
          const parts = []
          for (let i = 0; i < e.results.length; i++) {
            const t = (e.results[i][0] && e.results[i][0].transcript || '').trim()
            if (t) parts.push(t)
          }
          words = parts.join(' ')
          if (hooks.heard) hooks.heard(words)
        })
        rec.addEventListener('error', (e) => {
          // 'aborted' is our own cancel; 'no-speech' only matters if nothing was heard.
          if (e.error !== 'aborted') problem = e
          if (!listening) reject(e)
        })
        ended = new Promise((done) => rec.addEventListener('end', () => {
          stopTick()
          if (!listening) reject(problem || { error: 'audio-capture' })
          else if (!stopping && hooks.ended) hooks.ended(problem ? 'error' : 'quiet')
          done()
        }, { once: true }))
        rec.start()
      })
    },
    async stop() {
      stopping = true
      stopTick()
      try {
        rec.stop()
      } catch {
        // already ended
      }
      await ended
      if (!words && problem) throw problem
      return words
    },
    cancel() {
      stopping = true
      stopTick()
      try {
        rec.abort()
      } catch {
        // already ended
      }
    },
  }
}
