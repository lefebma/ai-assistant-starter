/**
 * Conversations shaped like a real ChatGPT export (checked against one,
 * 2026-11-09), with made-up content. A thread is a chain of nodes from a
 * root; `current_node` is the last message shown.
 */
export interface FixtureMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  text?: string
  parts?: unknown[]
  contentType?: string
  recipient?: string
  hidden?: boolean
  at?: number
}

export function conversation(opts: {
  id: string
  project?: string | null
  title?: string
  created?: number
  updated?: number
  messages: FixtureMessage[]
  /** Extra nodes off the root that the thread does not pass through (an edited-away branch). */
  branch?: FixtureMessage[]
}): Record<string, unknown> {
  const mapping: Record<string, unknown> = {}
  const root = `${opts.id}-root`
  mapping[root] = { id: root, message: null, parent: null, children: [] }
  const chain = (msgs: FixtureMessage[], prefix: string): string => {
    let parent = root
    msgs.forEach((m, i) => {
      const id = `${opts.id}-${prefix}${i}`
      mapping[id] = {
        id,
        parent,
        children: [],
        message: {
          id,
          author: { role: m.role },
          create_time: m.at ?? null,
          content: { content_type: m.contentType ?? 'text', parts: m.parts ?? [m.text ?? ''] },
          recipient: m.recipient ?? 'all',
          metadata: m.hidden ? { is_visually_hidden_from_conversation: true } : {},
        },
      }
      parent = id
    })
    return parent
  }
  if (opts.branch) chain(opts.branch, 'b')
  const current = chain(opts.messages, 'm')
  return {
    id: opts.id,
    conversation_id: opts.id,
    title: opts.title ?? `Conversation ${opts.id}`,
    create_time: opts.created ?? 1735689600, // 2025-01-01
    update_time: opts.updated ?? opts.created ?? 1735689600,
    current_node: current,
    conversation_template_id: opts.project === undefined ? 'g-p-aaaa1111' : opts.project,
    mapping,
    is_archived: false,
    memory_scope: 'global_enabled',
  }
}

/** A day, as seconds: `day('2025-03-14')`. */
export const day = (d: string, hour = 12): number => Date.parse(`${d}T${String(hour).padStart(2, '0')}:00:00Z`) / 1000
