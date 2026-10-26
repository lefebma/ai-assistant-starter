// Voice chat from the chat bar (card #248): the live two-way voice call, run
// inside the current conversation. No DOM here beyond the audio element the
// page hands over, so the call logic can be tested with fakes.
//
// The browser talks to the voice service over WebRTC. The box creates the
// session (it holds the key and signs the call in with the web session) and
// files the transcript in the conversation when the call ends. Calls are
// billed by the second, so every way out tells the box to end the session.

/** How long a started session may take to say it is live. */
export const START_TIMEOUT_MS = 20000
/** How often a live call asks the box whether it is still open there. */
export const STATUS_POLL_MS = 10000
/** The longest call this page keeps up, whatever the box says (the box stops at 45 minutes too). */
export const MAX_CALL_MS = 45 * 60000
/** No one has said anything and nothing is being looked up: the page hangs up (the box does at 5 minutes). */
export const SILENCE_MS = 6 * 60000

/** How often a call that ended without the transcript asks the box again. */
export const END_RETRY_MS = 3000
/** How long it keeps asking: long enough for a dropped wifi to come back. */
export const END_RETRY_FOR_MS = 3 * 60000

/** '' when this browser can make a call, else why not: 'insecure' or 'unsupported'. */
export function voiceCallSupport(win = globalThis) {
  if (!win.isSecureContext) return 'insecure'
  const md = win.navigator && win.navigator.mediaDevices
  if (!md || typeof md.getUserMedia !== 'function' || typeof win.RTCPeerConnection !== 'function') return 'unsupported'
  return ''
}

/** Plain-language reason a call could not start, or dropped. Never a stack. */
export function callProblem(err) {
  if (err === 'insecure') return 'Voice chat needs the secure (https) address of this page. Open the web app through its https link.'
  if (err === 'unsupported') return 'This browser cannot make voice calls. Try a current Chrome, Safari, Edge or Firefox.'
  const name = (err && err.name) || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "The microphone is blocked for this page. Allow it in your browser's settings for this site, then tap the voice chat button again."
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Connect one, then try again.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app. Close it there, then try again.'
  const code = (err && err.code) || ''
  const status = (err && err.status) || 0
  if (status === 503) return 'Voice chat is not set up on this assistant.'
  if (status === 429) return 'Two voice calls are already open on this assistant. End one first.'
  if (code === 'call_ended') return 'The call was stopped before it connected.'
  if (status === 409 || code === 'call_active') return 'A voice call is already open in this chat, maybe in another tab. End it there first.'
  if (status === 502) return 'Could not reach the voice service. Try again in a moment.'
  if (status === 404) return 'That chat is gone. Pick another one and try again.'
  if (name === 'TypeError') return 'Could not reach your assistant. Check your connection and try again.'
  if (err && err.message === 'connection_lost') return 'The call dropped. What was said is in the chat.'
  return 'The voice call did not work. Try again.'
}

/**
 * One call. `deps`: { getUserMedia, RTCPeerConnection, MediaStream, audio,
 * startSession(sdp) -> { sessionId, sdp }, endSession(sessionId, { wait, keepalive }),
 * callStatus(sessionId) -> { finished } }. callStatus is optional; with it, a
 * live call notices when the box ended it (idle, too long, /cancel, or the
 * box lost its own line to the voice service) and hangs up its side too.
 * `hooks`: { live(), caption(who, delta, startMs, endMs), working(count),
 * ended(why, result), caughtUp(result) } where why is 'stopped', 'closed' or
 * 'lost', and result is what the box said when it ended (null if it could not
 * be reached). ended runs once. When the box could not be reached, or had not
 * filed the transcript yet, the call keeps asking and runs caughtUp once: with
 * the box's answer when it has filed it, or null when it gave up.
 */
export function createVoiceCall(deps, hooks = {}) {
  const call = { phase: '', sessionId: '', pending: 0, muted: false }
  let mic = null
  let peer = null
  let events = null
  let over = false
  let stopWanted = false
  let watch = null
  let liveAt = 0
  let heardAt = 0
  let asking = false

  // The browser holds the call itself, so it must always be able to hang up:
  // on its own clock, and when the box says the call is over there.
  function tick(now = Date.now()) {
    if (call.phase !== 'live') return
    if (now - liveAt >= MAX_CALL_MS) return finish('closed')
    if (call.pending === 0 && now - heardAt >= SILENCE_MS) return finish('closed')
    if (!deps.callStatus || asking) return
    asking = true
    Promise.resolve()
      .then(() => deps.callStatus(call.sessionId))
      .then(
        (r) => {
          if (r && r.finished) finish('closed')
        },
        (err) => {
          // The box no longer knows the call (it restarted) or this page was signed out.
          const status = (err && err.status) || 0
          if (status === 404 || status === 401) finish('lost')
        }
      )
      .finally(() => {
        asking = false
      })
  }

  function release() {
    if (watch) clearInterval(watch)
    watch = null
    if (events) {
      events.onclose = null
      events.onmessage = null
    }
    if (peer) peer.onconnectionstatechange = null
    try { mic && mic.getTracks().forEach((t) => t.stop()) } catch {}
    try { events && events.close() } catch {}
    try { peer && peer.close() } catch {}
    if (deps.audio) deps.audio.srcObject = null
    mic = peer = events = null
  }

  async function finish(why) {
    if (over) return
    over = true
    const sessionId = call.sessionId
    call.phase = 'ending'
    release()
    let result = null
    if (sessionId) {
      try {
        result = await deps.endSession(sessionId, { wait: true })
      } catch {
        result = null
      }
    }
    call.phase = ''
    call.sessionId = ''
    if (hooks.ended) hooks.ended(why, result)
    if (sessionId && !(result && result.finished)) catchUp(sessionId)
  }

  // The call ended while this page could not reach the box (a dropped
  // connection usually takes this page's network with it), or before the box
  // had filed the transcript. Asking again also ends the call there if it is
  // somehow still open.
  function catchUp(sessionId) {
    const until = Date.now() + END_RETRY_FOR_MS
    const again = () => {
      const t = setTimeout(ask, END_RETRY_MS)
      if (t && t.unref) t.unref()
    }
    const done = (result) => {
      if (hooks.caughtUp) hooks.caughtUp(result)
    }
    const ask = () => {
      Promise.resolve()
        .then(() => deps.endSession(sessionId, { wait: true }))
        .then(
          (r) => {
            if (r && r.finished) return done(r)
            if (Date.now() >= until) return done(null)
            again()
          },
          (err) => {
            const status = (err && err.status) || 0
            // The box forgot the call (it restarted) or this page was signed out.
            if (status === 404 || status === 401 || Date.now() >= until) return done(null)
            again()
          }
        )
    }
    again()
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'session.started':
        if (call.phase !== 'connecting') break
        call.phase = 'live'
        liveAt = heardAt = Date.now()
        watch = setInterval(tick, STATUS_POLL_MS)
        if (watch && watch.unref) watch.unref()
        if (hooks.live) hooks.live()
        break
      case 'session.input_transcript.delta':
        heardAt = Date.now()
        if (hooks.caption) hooks.caption('user', String(ev.delta || ''), ev.start_ms || 0, ev.end_ms || 0)
        break
      case 'session.output_transcript.delta':
        heardAt = Date.now()
        if (hooks.caption) hooks.caption('assistant', String(ev.delta || ''), ev.start_ms || 0, ev.end_ms || 0)
        break
      case 'session.delegation.created':
        heardAt = Date.now()
        call.pending++
        if (hooks.working) hooks.working(call.pending)
        break
      case 'session.commentary.appended':
        heardAt = Date.now()
        call.pending = Math.max(0, call.pending - 1)
        if (hooks.working) hooks.working(call.pending)
        break
      case 'session.closed':
        finish('closed')
        break
    }
  }

  return {
    get phase() { return call.phase },
    get sessionId() { return call.sessionId },
    get muted() { return call.muted },
    /** Lookups the assistant is running for the call. */
    get pending() { return call.pending },

    /** Ask for the microphone, connect, and start the session. Rejects when it cannot. */
    async start() {
      call.phase = 'connecting'
      // iOS only plays audio started from the tap itself.
      if (deps.audio) Promise.resolve(deps.audio.play && deps.audio.play()).catch(() => {})
      try {
        mic = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        if (stopWanted) throw Object.assign(new Error('stopped'), { name: 'AbortError', stopped: true })
        peer = new deps.RTCPeerConnection()
        peer.ontrack = (e) => {
          if (!deps.audio) return
          deps.audio.srcObject = new deps.MediaStream([e.track])
          Promise.resolve(deps.audio.play && deps.audio.play()).catch(() => {})
        }
        for (const t of mic.getAudioTracks()) peer.addTrack(t, mic)
        events = peer.createDataChannel('oai-events')
        events.onmessage = ({ data }) => {
          let ev
          try {
            ev = JSON.parse(data)
          } catch {
            return
          }
          onEvent(ev)
        }
        events.onclose = () => {
          if (call.phase === 'live') finish('lost')
        }
        peer.onconnectionstatechange = () => {
          if (call.phase === 'live' && (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')) finish('lost')
        }
        await peer.setLocalDescription(await peer.createOffer())
        if (peer.iceGatheringState !== 'complete') {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 4000)
            peer.onicegatheringstatechange = () => {
              if (peer && peer.iceGatheringState === 'complete') {
                clearTimeout(t)
                resolve()
              }
            }
          })
        }
        if (stopWanted) throw Object.assign(new Error('stopped'), { name: 'AbortError', stopped: true })
        const r = await deps.startSession(peer.localDescription.sdp)
        // The page went away while the box was creating it: end it, or it bills until the idle limit.
        if (over) {
          try {
            deps.endSession(r.sessionId, { keepalive: true })
          } catch {}
          return
        }
        call.sessionId = r.sessionId
        // End pressed while the box was creating it: it bills from now, so end it now.
        if (stopWanted) {
          await finish('stopped')
          return
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: r.sdp })
        // Connected on paper but never heard from: end it rather than pay for silence.
        const t = setTimeout(() => {
          if (call.phase === 'connecting') finish('lost')
        }, START_TIMEOUT_MS)
        if (t && t.unref) t.unref()
      } catch (err) {
        if (call.sessionId) {
          await finish('lost')
          throw err
        }
        over = true
        release()
        call.phase = ''
        throw err
      }
    },

    /** End the call (the End button). Resolves once the box has the transcript, or gave up. */
    async stop() {
      if (call.phase === 'connecting' && !call.sessionId) {
        stopWanted = true
        return
      }
      await finish('stopped')
    },

    /** The page is going away: tell the box without waiting. */
    leave() {
      if (over) return
      over = true
      const sessionId = call.sessionId
      release()
      call.phase = ''
      call.sessionId = ''
      if (sessionId) {
        try {
          deps.endSession(sessionId, { keepalive: true })
        } catch {}
      }
    },

    mute(on) {
      if (call.phase !== 'live' || !events) return
      call.muted = !!on
      try {
        events.send(JSON.stringify({ type: call.muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' }))
      } catch {}
    },
  }
}
