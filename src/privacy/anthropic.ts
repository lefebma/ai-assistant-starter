/**
 * The anonymizer on Anthropic's Messages API wire format (card #187), for
 * the Claude CLI's requests that proxy.ts passes through.
 *
 * Out: every piece of text the CLI sends (system prompt, messages, tool
 * results, tool inputs) is masked. In: the reply's text and tool inputs are
 * restored, so the CLI shows real names and its tools act on real names.
 *
 * Left exactly as they are, both ways: thinking blocks (the API checks their
 * signature, and they are never shown), images, server tool blocks (web
 * search results are encrypted), tool names and ids.
 */
import { PRIVACY_NOTE, PrivacyRefusal, isTextMedia, mapBase64Text, type Masking, type StreamRestorer } from './mask.js'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const UNTOUCHED_BLOCKS = new Set(['thinking', 'redacted_thinking', 'image', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result', 'code_execution_tool_result', 'container_upload'])
// Keys whose values are ids, types or encoded data, never prose.
const OPAQUE_KEYS = new Set(['type', 'id', 'tool_use_id', 'signature', 'media_type', 'cache_control', 'encrypted_content', 'encrypted_index', 'file_id', 'citations'])

const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every string in `v`, object keys included: tool inputs have no fields that are safe to skip. */
function deep(v: Json, f: (s: string) => string): Json {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => deep(x, f))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), deep(x, f)]))
  return v
}

/** A block's prose, with ids, types and encoded data left alone. */
function deepProse(v: Json, f: (s: string) => string): Json {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => deepProse(x, f))
  if (isObj(v)) {
    if (v.type === 'base64' || v.type === 'url' || v.type === 'file') return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, OPAQUE_KEYS.has(k) ? x : deepProse(x, f)]))
  }
  return v
}

function block(b: Json, f: (s: string) => string): Json {
  if (typeof b === 'string') return f(b)
  if (!isObj(b)) return b
  const type = typeof b.type === 'string' ? b.type : ''
  if (UNTOUCHED_BLOCKS.has(type)) return b
  if (type === 'tool_use') return { ...b, ...(b.input !== undefined ? { input: deep(b.input, f) } : {}) }
  if (type === 'tool_result') {
    const c = b.content
    return { ...b, ...(c === undefined ? {} : { content: typeof c === 'string' ? f(c) : Array.isArray(c) ? c.map((x) => block(x, f)) : c }) }
  }
  // A document whose source is a base64 text file: its text, decoded and masked.
  if (type === 'document' && isObj(b.source) && b.source.type === 'base64' && isTextMedia(b.source.media_type) && typeof b.source.data === 'string') {
    const masked = deepProse({ ...b, source: null }, f) as Obj
    return { ...masked, source: { ...b.source, data: mapBase64Text(b.source.data, f) } }
  }
  // text, document, search_result and anything newer: the prose in it.
  return deepProse(b, f)
}

function content(c: Json | undefined, f: (s: string) => string): Json | undefined {
  if (c === undefined) return c
  if (typeof c === 'string') return f(c)
  if (Array.isArray(c)) return c.map((x) => block(x, f))
  return c
}

/** A Messages request body with `f` applied to all of its prose. */
function mapRequest(body: Obj, f: (s: string) => string): Obj {
  const out: Obj = { ...body }
  if (body.system !== undefined) out.system = content(body.system, f) as Json
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((m) => (isObj(m) ? { ...m, ...(m.content !== undefined ? { content: content(m.content, f) as Json } : {}) } : m))
  }
  return out
}

/**
 * Every piece of prose in a request, to look for emails and phones before
 * masking. Thinking is included: it goes out unchanged, so an address in it
 * must be on the list for the block to be caught and left out.
 */
export function requestTexts(body: Obj): string[] {
  const texts: string[] = []
  mapRequest(body, (s) => {
    texts.push(s)
    return s
  })
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isObj(m) || !Array.isArray(m.content)) continue
      for (const b of m.content) if (isObj(b) && b.type === 'thinking' && typeof b.thinking === 'string') texts.push(b.thinking)
    }
  }
  return texts
}

/**
 * Thinking blocks go out as the AI wrote them (they are signed), so one that
 * holds a listed name (written before the name was added or the filter was
 * on) is left out, which the API allows, except in a tool loop still
 * running, where it must stay, so the request is refused (PrivacyRefusal).
 */
function dropNamedThinking(messages: Json[], masker: Masking): Json[] {
  // Only the assistant turn of a tool loop still running (the request ends
  // with its tool results) must keep its thinking.
  let last = -1
  messages.forEach((m, i) => {
    if (isObj(m) && m.role === 'assistant') last = i
  })
  const tail = messages[messages.length - 1]
  const looping = isObj(tail) && tail.role === 'user' && Array.isArray(tail.content) && tail.content.some((b) => isObj(b) && b.type === 'tool_result')
  if (!looping) last = -1
  return messages.map((m, i) => {
    if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.content)) return m
    const named = (b: Json) => isObj(b) && b.type === 'thinking' && typeof b.thinking === 'string' && masker.matches(b.thinking)
    if (!m.content.some(named)) return m
    if (i === last) throw new PrivacyRefusal()
    const kept = m.content.filter((b) => !named(b))
    return { ...m, content: kept.length ? kept : [{ type: 'text', text: '(earlier reasoning left out)' }] }
  })
}

/** The request as it may leave: masked, with the privacy note last in the system prompt. Throws PrivacyRefusal. */
export function maskRequest(body: Obj, masker: Masking): Obj {
  const cleaned = Array.isArray(body.messages) ? { ...body, messages: dropNamedThinking(body.messages, masker) } : body
  const out = mapRequest(cleaned, (s) => masker.mask(s))
  // Only a request with messages (a turn or its token count) gets the note.
  if (!Array.isArray(out.messages)) return out
  const note: Obj = { type: 'text', text: PRIVACY_NOTE }
  const sys = out.system
  out.system = sys === undefined || sys === null || sys === '' ? [note] : typeof sys === 'string' ? [{ type: 'text', text: sys }, note] : Array.isArray(sys) ? [...sys, note] : sys
  return out
}

/** A whole (not streamed) Messages response with names restored. */
export function restoreResponse(body: Obj, masker: Masking): Obj {
  if (!Array.isArray(body.content)) return body
  return {
    ...body,
    content: body.content.map((b) => {
      if (!isObj(b)) return b
      if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: masker.restore(b.text) }
      if (b.type === 'tool_use' && b.input !== undefined) return { ...b, input: deep(b.input, (s) => masker.restore(s)) }
      return b
    }),
  }
}

/**
 * Restores a streamed (server-sent events) Messages response, chunk by chunk.
 * Text and tool-input deltas go through a StreamRestorer per content block;
 * what is still held when a block stops goes out as one more delta first.
 */
export class SseRestorer {
  private buf = ''
  private readonly blocks = new Map<number, { kind: 'text' | 'json'; r: StreamRestorer }>()
  constructor(private readonly masker: Masking) {}

  /** Restored output for this chunk of the stream (complete events only). */
  feed(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf)
      if (!m) break
      const raw = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      out += this.event(raw)
    }
    return out
  }

  /** Anything left when the stream ends, passed on as it is. */
  end(): string {
    const rest = this.buf
    this.buf = ''
    return rest
  }

  private event(raw: string): string {
    const lines = raw.split(/\r?\n/)
    const eventLine = lines.find((l) => l.startsWith('event:'))
    const dataLines = lines.filter((l) => l.startsWith('data:'))
    if (!dataLines.length) return `${raw}\n\n`
    const dataText = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n')
    let data: Json
    try {
      data = JSON.parse(dataText) as Json
    } catch {
      return `${raw}\n\n`
    }
    if (!isObj(data)) return `${raw}\n\n`
    const name = eventLine ? eventLine.slice(6).trim() : String(data.type ?? '')
    const emit = (d: Obj) => `event: ${String(d.type ?? name)}\ndata: ${JSON.stringify(d)}\n\n`
    const index = typeof data.index === 'number' ? data.index : -1

    if (data.type === 'content_block_start' && isObj(data.content_block)) {
      const cb = data.content_block
      if (cb.type === 'text') {
        const r = this.masker.stream(false)
        this.blocks.set(index, { kind: 'text', r })
        return emit({ ...data, content_block: { ...cb, text: typeof cb.text === 'string' ? r.push(cb.text) : cb.text } })
      }
      if (cb.type === 'tool_use') {
        this.blocks.set(index, { kind: 'json', r: this.masker.stream(true) })
        return emit({ ...data, content_block: cb.input !== undefined ? { ...cb, input: deep(cb.input, (s) => this.masker.restore(s)) } : cb })
      }
      return `${raw}\n\n`
    }
    if (data.type === 'content_block_delta' && isObj(data.delta)) {
      const b = this.blocks.get(index)
      const d = data.delta
      if (b && d.type === 'text_delta' && typeof d.text === 'string') return emit({ ...data, delta: { ...d, text: b.r.push(d.text) } })
      if (b && d.type === 'input_json_delta' && typeof d.partial_json === 'string') return emit({ ...data, delta: { ...d, partial_json: b.r.push(d.partial_json) } })
      return `${raw}\n\n`
    }
    if (data.type === 'content_block_stop') {
      const b = this.blocks.get(index)
      this.blocks.delete(index)
      const held = b ? b.r.flush() : ''
      if (!held) return `${raw}\n\n`
      const delta: Obj = b!.kind === 'text' ? { type: 'text_delta', text: held } : { type: 'input_json_delta', partial_json: held }
      return emit({ type: 'content_block_delta', index, delta }) + `${raw}\n\n`
    }
    return `${raw}\n\n`
  }
}

export type { Obj as MessagesBody }
