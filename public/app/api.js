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
 * Send a chat message and read the reply as server-sent events. EventSource
 * cannot POST, so this parses the stream from fetch. handlers: onQueued,
 * onDelta, onReset, onTool, onReply, onDropped, onDone, onPaused, onError.
 * A slash command answers with reply events (one stored message each), and
 * dropped when it removed the owner's message (a pasted key). Resolves when the stream ends;
 * resolves to true when a terminal event arrived, false when it was cut off.
 */
export async function streamChat(conversationId, text, handlers, extra = {}) {
  const res = await check(
    await fetch('/api/web/conversations/' + encodeURIComponent(conversationId) + '/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      // extra: { attachments: [upload paths], pastes: [text] } (card #249)
      body: JSON.stringify({ text, ...extra }),
    })
  )
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
    switch (name) {
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
        handlers.onDropped?.()
        break
      case 'done':
        finished = true
        handlers.onDone?.(payload)
        break
      case 'paused':
        finished = true
        handlers.onPaused?.(payload.text || '')
        break
      case 'error':
        finished = true
        handlers.onError?.(payload.message || '')
        break
    }
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
