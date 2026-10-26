// Thin client for /api/web/*. Same origin, cookie auth, JSON bodies.

export class ApiError extends Error {
  constructor(status, code, body) {
    super(code || 'http_' + status)
    this.status = status
    this.code = code || ''
    this.body = body
  }
}

let signedOutHandler = () => {}

/** Called once by the app: what to do when any call comes back 401. */
export function setSignedOutHandler(fn) {
  signedOutHandler = fn
}

async function readBody(res) {
  const type = res.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  return null
}

async function check(res) {
  if (res.ok) return res
  const body = await readBody(res)
  if (res.status === 401) signedOutHandler()
  throw new ApiError(res.status, body && body.error, body)
}

export async function get(path) {
  const res = await check(await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }))
  return readBody(res)
}

export async function post(path, body = {}) {
  const res = await check(
    await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return readBody(res)
}

/** Upload one File to workspace/uploads. Resolves to the stored relative path. */
export async function upload(file) {
  const res = await check(
    await fetch('/api/web/files/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Havn-Web': '1' },
      body: file,
    })
  )
  const body = await readBody(res)
  return body && body.path
}

/**
 * Send a dictated recording to the box (card #252). Resolves to the words it
 * heard. The box deletes the recording once it has the words.
 */
export async function transcribe(blob) {
  const res = await check(
    await fetch('/api/web/dictation', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Havn-Web': '1', Accept: 'application/json' },
      body: blob,
    })
  )
  const body = await readBody(res)
  return (body && body.text) || ''
}

/**
 * Start a voice call in a conversation (card #248): the browser's WebRTC
 * offer goes to the box, which creates the session. Resolves to { sessionId, sdp }.
 */
export async function startVoiceCall(conversationId, sdp) {
  return post('/api/web/conversations/' + encodeURIComponent(conversationId) + '/voice', { sdp })
}

/**
 * End a voice call. `wait` holds the answer until the transcript is in the
 * chat. `keepalive` lets the request outlive the page (it is closing).
 */
export async function endVoiceCall(sessionId, { wait = false, keepalive = false } = {}) {
  const res = await fetch('/api/web/voice/end', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sessionId, wait }),
  })
  if (keepalive) return null
  await check(res)
  return readBody(res)
}

/** Whether a voice call is still open on the box: { finished, added }. */
export async function voiceCallStatus(sessionId) {
  return get('/api/web/voice/calls/' + encodeURIComponent(sessionId))
}

/** Exchange a one-time link token for a session cookie. Never triggers the signed-out handler. */
export async function exchange(token) {
  const res = await fetch('/api/web/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return res.ok
}

/**
 * Read a server-sent-events response, calling onEvent(name, payload) for each
 * event. Stops after an event for which isLast(name) is true, and resolves to
 * true then; false when the stream was cut off first.
 */
async function readEvents(res, onEvent, isLast) {
  if (!res.body) return false
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const dispatch = (block) => {
    let name = 'message'
    const data = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') name = value
      else if (field === 'data') data.push(value)
    }
    if (!data.length) return
    let payload
    try {
      payload = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    if (isLast(name)) finished = true
    onEvent(name, payload)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let cut
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        dispatch(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 2)
        if (finished) break
      }
      if (finished) break
    }
  } catch {
    // Connection dropped. The turn keeps running on the box and is stored.
  } finally {
    if (finished) reader.cancel().catch(() => {})
  }
  if (!finished && buffer.trim()) dispatch(buffer)
  return finished
}

/** One turn's events, to the matching handler. */
function turnEvent(handlers, name, payload) {
  switch (name) {
    case 'start':
      // A message's turn has started: the one this send made, or, when
      // following, each waiting message in turn. Names it, never its words.
      if (payload.item) handlers.onStart?.(payload.item)
      break
    case 'user':
      // The owner's message, as stored.
      if (payload.message) handlers.onUser?.(payload.message)
      break
    case 'queued':
      handlers.onQueued?.(payload.ahead || 0)
      break
    case 'delta':
      handlers.onDelta?.(payload.text || '')
      break
    case 'reset':
      // The reply restarted (a retry): replace what was shown so far.
      handlers.onReset?.(payload.text || '')
      break
    case 'tool':
      handlers.onTool?.(payload.tool || '', payload.status || '')
      break
    case 'reply':
      if (payload.message) handlers.onReply?.(payload.message)
      break
    case 'dropped':
      // The command removed the owner's message (it held a key).
      handlers.onDropped?.()
      break
    case 'done':
      handlers.onDone?.(payload)
      break
    case 'paused':
      // The AI limit was reached: the box says when it resumes.
      handlers.onPaused?.(payload.text || '')
      break
    case 'error':
      handlers.onError?.(payload.message || '')
      break
    case 'idle':
      handlers.onIdle?.()
      break
  }
}

/**
 * Send a chat message and read the reply as server-sent events. EventSource
 * cannot POST, so this parses the stream from fetch. handlers: onUser,
 * onQueued, onDelta, onReset, onTool, onReply, onDropped, onDone, onPaused,
 * onError, and onItem. A slash command answers with reply events (one stored
 * message each), and dropped when it removed the owner's message (a pasted key).
 *
 * A message sent while a reply is in progress is not answered here: the box
 * keeps it in the conversation's queue and says so with JSON, which goes to
 * onItem(item) (card #250). extra.clientId names the message, so sending it
 * again finds the same one instead of a second copy.
 *
 * Resolves to true when a terminal event (or the queued answer) arrived,
 * false when the stream was cut off.
 */
export async function streamChat(conversationId, text, handlers, extra = {}) {
  const res = await check(
    await fetch('/api/web/conversations/' + encodeURIComponent(conversationId) + '/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      // extra: { attachments: [upload paths], pastes: [text] } (card #249), clientId (card #250)
      body: JSON.stringify({ text, ...extra }),
    })
  )
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const body = await readBody(res)
    if (body && body.item) handlers.onItem?.(body.item)
    return true
  }
  return readEvents(res, (name, payload) => turnEvent(handlers, name, payload), (name) => name === 'done' || name === 'paused' || name === 'error')
}

/**
 * Follow a conversation: the reply in progress (what it has said so far, then
 * live), then each waiting message as it starts (onStart), until nothing is
 * left (onIdle). Resolves to true when it reached the end, false when the
 * connection dropped or `signal` aborted it.
 */
export async function follow(conversationId, handlers, signal) {
  let res
  try {
    res = await check(
      await fetch('/api/web/conversations/' + encodeURIComponent(conversationId) + '/stream', {
        credentials: 'same-origin',
        headers: { Accept: 'text/event-stream' },
        signal,
      })
    )
  } catch (err) {
    if (err instanceof ApiError) throw err
    return false
  }
  return readEvents(res, (name, payload) => turnEvent(handlers, name, payload), (name) => name === 'idle')
}
