/**
 * The anonymizer for the ai-sdk runtime (card #187): a language model
 * middleware, so one piece covers every provider that runtime reaches
 * (Anthropic, OpenAI, Google, Azure, an OpenAI-compatible host).
 *
 * Out: every piece of text in the prompt is masked, tool names, ids and file
 * data aside. Reasoning parts go out as they came back. In: text deltas and
 * tool inputs are restored, so tools act on real names and the reply shows
 * them.
 */
import type { LanguageModelV3Middleware, LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { PRIVACY_NOTE, PrivacyRefusal, type Masker, type MaskScope, type StreamRestorer } from './mask.js'
import { maskerFor } from './store.js'

type Any = unknown
type Part = { type: string; [k: string]: Any }

/** Every string in `v`, object keys included: tool data has no fields that are safe to skip. */
function deepAll(v: Any, f: (s: string) => string): Any {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => deepAll(x, f))
  if (v && typeof v === 'object') {
    if (v instanceof Uint8Array || v instanceof URL) return v
    return Object.fromEntries(Object.entries(v as Record<string, Any>).map(([k, x]) => [f(k), deepAll(x, f)]))
  }
  return v
}

/** A tool result's output: text, JSON, or content with text and media. */
function output(o: Any, f: (s: string) => string): Any {
  if (!o || typeof o !== 'object') return o
  const out = o as { type?: string; value?: Any }
  switch (out.type) {
    case 'text':
    case 'error-text':
      return typeof out.value === 'string' ? { ...out, value: f(out.value) } : out
    case 'json':
    case 'error-json':
      return { ...out, value: deepAll(out.value, f) }
    case 'content':
      return Array.isArray(out.value)
        ? { ...out, value: out.value.map((c) => (c && typeof c === 'object' && (c as Part).type === 'text' && typeof (c as Part).text === 'string' ? { ...(c as Part), text: f((c as Part).text as string) } : c)) }
        : out
    default:
      // A newer output shape: its strings, keys included.
      return deepAll(o, f)
  }
}

/**
 * One message part. Text, tool inputs and tool results are walked in full;
 * reasoning goes back exactly as it came (some providers sign it) and files
 * are sent as they are.
 */
function part(p: Part, f: (s: string) => string): Part {
  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? { ...p, text: f(p.text) } : p
    case 'tool-call':
      return { ...p, input: deepAll(p.input, f) }
    case 'tool-result':
      return { ...p, output: output(p.output, f) }
    default:
      return p
  }
}

function mapPrompt(prompt: LanguageModelV3Prompt, f: (s: string) => string): LanguageModelV3Prompt {
  return prompt.map((m) => {
    if (m.role === 'system') return { ...m, content: f(m.content) }
    return { ...m, content: (m.content as unknown as Part[]).map((p) => part(p, f)) } as unknown as typeof m
  })
}

/**
 * Reasoning goes out as it came back (some providers sign it), so a part
 * that holds a listed name is left out, except in a tool loop still
 * running, where it must stay: PrivacyRefusal.
 */
function dropNamedReasoning(prompt: LanguageModelV3Prompt, masker: MaskScope): LanguageModelV3Prompt {
  let last = -1
  prompt.forEach((m, i) => {
    if (m.role === 'assistant') last = i
  })
  // Only a tool loop still running (the prompt ends with tool results) must keep it.
  if (prompt[prompt.length - 1]?.role !== 'tool') last = -1
  return prompt.map((m, i) => {
    if (m.role !== 'assistant') return m
    const parts = m.content as unknown as Part[]
    const named = (p: Part) => p.type === 'reasoning' && typeof p.text === 'string' && masker.matches(p.text)
    if (!parts.some(named)) return m
    if (i === last) throw new PrivacyRefusal()
    return { ...m, content: parts.filter((p) => !named(p)) } as unknown as typeof m
  })
}

/** Every piece of text in a prompt, to look for emails and phones first. */
export function promptTexts(prompt: LanguageModelV3Prompt): string[] {
  const out: string[] = []
  mapPrompt(prompt, (s) => {
    out.push(s)
    return s
  })
  return out
}

/** A tool call's input (a JSON string) with names restored. */
function restoreInput(input: string, masker: MaskScope): string {
  try {
    return JSON.stringify(deepAll(JSON.parse(input), (s) => masker.restore(s)))
  } catch {
    return masker.restore(input, true)
  }
}

/** The middleware. `masker` is a test seam; normally the box's list is read per call. */
export function privacyMiddleware(pick: (texts: string[]) => Masker = (t) => maskerFor(t)): LanguageModelV3Middleware {
  const maskers = new WeakMap<object, MaskScope>()
  const masked = (params: { prompt: LanguageModelV3Prompt }) => {
    const masker = pick(promptTexts(params.prompt)).scope()
    const prompt = mapPrompt(dropNamedReasoning(params.prompt, masker), (s) => masker.mask(s))
    // After the system messages, so a cached system prompt stays cached.
    const firstOther = prompt.findIndex((m) => m.role !== 'system')
    const at = firstOther < 0 ? prompt.length : firstOther
    const out = { ...params, prompt: [...prompt.slice(0, at), { role: 'system' as const, content: PRIVACY_NOTE }, ...prompt.slice(at)] }
    maskers.set(out, masker)
    return out
  }
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => masked(params) as typeof params,
    wrapGenerate: async ({ doGenerate, params }) => {
      const masker = maskers.get(params) ?? pick([]).scope()
      const result = await doGenerate()
      return {
        ...result,
        content: result.content.map((c) => {
          if (c.type === 'text') return { ...c, text: masker.restore(c.text) }
          if (c.type === 'tool-call') return { ...c, input: restoreInput(c.input, masker) }
          return c
        }),
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const masker = maskers.get(params) ?? pick([]).scope()
      const { stream, ...rest } = await doStream()
      const open = new Map<string, StreamRestorer>()
      const restorer = (id: string, json: boolean) => {
        let r = open.get(id)
        if (!r) open.set(id, (r = masker.stream(json)))
        return r
      }
      const transform = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, ctl) {
          switch (part.type) {
            case 'text-delta': {
              ctl.enqueue({ ...part, delta: restorer(`t:${part.id}`, false).push(part.delta) })
              return
            }
            case 'text-end': {
              const held = open.get(`t:${part.id}`)?.flush() ?? ''
              open.delete(`t:${part.id}`)
              if (held) ctl.enqueue({ type: 'text-delta', id: part.id, delta: held })
              ctl.enqueue(part)
              return
            }
            case 'tool-input-delta': {
              ctl.enqueue({ ...part, delta: restorer(`i:${part.id}`, true).push(part.delta) })
              return
            }
            case 'tool-input-end': {
              const held = open.get(`i:${part.id}`)?.flush() ?? ''
              open.delete(`i:${part.id}`)
              if (held) ctl.enqueue({ type: 'tool-input-delta', id: part.id, delta: held })
              ctl.enqueue(part)
              return
            }
            case 'tool-call': {
              ctl.enqueue({ ...part, input: restoreInput(part.input, masker) })
              return
            }
            default:
              ctl.enqueue(part)
          }
        },
        flush(ctl) {
          // A provider that never sent text-end: pass on what is held.
          for (const [key, r] of open) {
            const held = r.flush()
            if (!held) continue
            const id = key.slice(2)
            ctl.enqueue(key.startsWith('t:') ? { type: 'text-delta', id, delta: held } : { type: 'tool-input-delta', id, delta: held })
          }
          open.clear()
        },
      })
      return { stream: stream.pipeThrough(transform), ...rest }
    },
  }
}
