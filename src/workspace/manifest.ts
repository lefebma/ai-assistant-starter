import type { SharedWith, WorkspaceManifest, WorkspaceMember } from './types.js'

const SHARED: SharedWith[] = ['partner', 'internal', 'client', 'unknown']

function frontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]+?)\n---/)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf(':')
    if (i === -1) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

function list(value: string | undefined): string[] {
  if (!value) return []
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** "Marc Lefebvre + Umi (owner)" -> { human, assistant, role } */
function member(text: string): WorkspaceMember {
  const roleMatch = text.match(/\(([^)]+)\)\s*$/)
  const role = roleMatch ? roleMatch[1].trim() : 'member'
  const body = roleMatch ? text.slice(0, roleMatch.index).trim() : text.trim()
  const plus = body.indexOf('+')
  const human = (plus === -1 ? body : body.slice(0, plus)).trim()
  const assistant = plus === -1 ? '' : body.slice(plus + 1).trim()
  return { human, assistant, role }
}

export function parseWorkspaceManifest(raw: string, fallbackName: string): WorkspaceManifest {
  const fm = frontmatter(raw)
  const shared = fm['shared-with'] as SharedWith | undefined
  return {
    name: fm.name || fallbackName,
    sharedWith: shared && SHARED.includes(shared) ? shared : 'unknown',
    members: list(fm.members).map(member),
    boards: list(fm.boards),
  }
}
