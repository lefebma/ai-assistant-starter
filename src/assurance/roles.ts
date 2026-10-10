/**
 * Role-scoped tools for scheduled jobs. Card #195, building on the capability
 * broker prototype (capabilities.ts, card #171).
 *
 * A scheduled task can name a role. Its unattended run then gets only that
 * role's tools: the model is not shown the others (where the runtime allows
 * hiding them), and every call is checked here before it runs, outside the
 * model. Chat is unaffected; it keeps every tool and the tool guard (#194).
 *
 * Havn reaches email and calendar through shell commands (gog, ms-mail.js),
 * not MCP, so a role covers three things:
 *   - tools:    built-in and MCP tool names ("Read", "mcp__playwright__*")
 *   - commands: shell commands as program + verb ("gog gmail search",
 *               "ms-mail.js draft"); every part of a compound command must match
 *   - writes:   path prefixes Write/Edit may touch, relative to the working dir
 *   - params:   optional limits on an MCP tool's arguments (validateParams)
 *
 * A request outside the role is refused, logged with the role that would have
 * allowed it, and the refusal tells the model to say so in its result. The
 * governed transition is the owner changing the task's role
 * (/schedule role <id> <role>); the model can ask, only the owner can grant.
 *
 * Unlike the tool guard, roles fail closed: a task that names a role nobody
 * defined does not run.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { validateParams, type ToolDef } from './capabilities.js'

export interface RoleSpec {
  id: string
  summary: string
  /** Tool names; a trailing * matches a prefix. "*" alone allows every tool. */
  tools: string[]
  /** Allowed shell commands, as "program verb ..." prefixes. Program matches by basename. */
  commands?: string[]
  /** Path prefixes, relative to the working directory, that Write/Edit may change. */
  writes?: string[]
  /** Argument limits for specific MCP tools. */
  params?: Record<string, ToolDef>
}

/** Read-only basics every role with a shell gets. */
const READ_BASICS = ['date', 'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'echo', 'sort', 'uniq', 'jq', 'find', 'cut', 'tr', 'basename', 'dirname', 'which']

export const BUILTIN_ROLES: RoleSpec[] = [
  {
    id: 'inbox-triage',
    summary: 'Read, search and draft email. Never sends, trashes or touches the calendar.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    commands: [
      ...READ_BASICS,
      'gog gmail search', 'gog gmail read', 'gog gmail labels', 'gog gmail thread',
      'gog gmail drafts create', 'gog gmail drafts list', 'gog gmail drafts get', 'gog gmail drafts update',
      'ms-mail.js inbox', 'ms-mail.js search', 'ms-mail.js read', 'ms-mail.js draft', 'ms-mail.js reply',
    ],
  },
  {
    id: 'briefing',
    summary: 'Read email and calendar and search the web for a summary. Changes nothing.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'],
    commands: [
      ...READ_BASICS, 'curl',
      'gog gmail search', 'gog gmail read', 'gog gmail thread', 'gog calendar events',
      'ms-mail.js inbox', 'ms-mail.js search', 'ms-mail.js read',
      'ms-calendar.js today', 'ms-calendar.js range',
    ],
  },
  {
    id: 'research',
    summary: 'Search and read the web, including with the browser, and save notes under output/.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch', 'Write', 'mcp__playwright__*'],
    commands: [...READ_BASICS, 'curl', 'mkdir'],
    writes: ['output/'],
    params: {
      // The browser may open web pages, not local files or other schemes.
      mcp__playwright__browser_navigate: { params: { url: { type: 'string', maxLength: 2000, pattern: /^https?:\/\//i } }, required: ['url'] },
    },
  },
  {
    id: 'full',
    summary: 'Every tool, as in chat. The same as giving the task no role.',
    tools: ['*'],
  },
]

/** Roles: built-ins, then any in roles.json (same id replaces a built-in). */
export function loadRoles(path?: string): Map<string, RoleSpec> {
  const roles = new Map(BUILTIN_ROLES.map((r) => [r.id, r]))
  if (!path) return roles
  try {
    const custom = JSON.parse(readFileSync(path, 'utf-8')) as Array<Omit<RoleSpec, 'params'> & { params?: Record<string, { params?: Record<string, { type: string; pattern?: string; [k: string]: unknown }>; required?: string[] }> }>
    for (const r of Array.isArray(custom) ? custom : []) {
      if (!r || typeof r.id !== 'string' || !Array.isArray(r.tools)) continue
      // JSON cannot carry a RegExp: patterns arrive as strings.
      const params = r.params ? Object.fromEntries(Object.entries(r.params).map(([tool, def]) => [tool, {
        ...def,
        params: def.params ? Object.fromEntries(Object.entries(def.params).map(([k, spec]) => [k, spec.pattern ? { ...spec, pattern: new RegExp(spec.pattern) } : spec])) : undefined,
      }])) as Record<string, ToolDef> : undefined
      roles.set(r.id, { ...r, params })
    }
  } catch {
    // No roles.json, or unreadable: built-ins only.
  }
  return roles
}

// --- matching -----------------------------------------------------------------

export function toolAllowed(role: RoleSpec, tool: string): boolean {
  return role.tools.some((t) => t === '*' || t === tool || (t.endsWith('*') && tool.startsWith(t.slice(0, -1))))
}

/** ai-sdk tool names, mapped onto the Claude names roles are written in. */
const AI_SDK_NAMES: Record<string, string> = { bash: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', dispatch_subagent: 'Task' }
export function canonicalTool(tool: string): string {
  return AI_SDK_NAMES[tool] ?? tool
}

function tokens(segment: string): string[] {
  return segment.replace(/^(?:\s*[A-Za-z_]\w*=\S*\s+)+/, '').trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ''))
}

/** "node /x/dist/scripts/ms-mail.js draft" -> ["ms-mail.js", "draft"]. */
function programWords(segment: string): string[] {
  const t = tokens(segment)
  if ((t[0] === 'node' || t[0] === 'npx') && t[1]) t.shift()
  if (t[0]) t[0] = t[0].split('/').pop()!
  return t
}

export function commandAllowed(role: RoleSpec, cmd: string): { ok: true } | { ok: false; reason: string } {
  const allow = role.commands ?? []
  // Command substitution and process substitution hide what actually runs.
  if (/\$\(|`|<\(|>\(/.test(cmd)) return { ok: false, reason: 'command substitution is not allowed in a scoped job' }
  const segments = cmd.split(/&&|\|\||[;\n|]/).map((s) => s.trim()).filter(Boolean)
  for (const raw of segments) {
    // Output redirection is a write: it needs the same allowance as Write.
    const redirect = raw.match(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|]+)/)
    const seg = raw.replace(/\d?>{1,2}\s*[^\s;&|]+/g, '').trim()
    if (redirect && !/^\/dev\/null$/.test(redirect[1]) && !role.writes?.some((w) => redirect[1].replace(/^\.\//, '').startsWith(w))) {
      return { ok: false, reason: `writing to ${redirect[1]} is outside this role` }
    }
    if (!seg || /^cd(\s|$)/.test(seg)) continue
    // Shell keywords are structure, not programs: check what they run.
    if (/^(?:done|fi|esac|\{|\})$/.test(seg) || /^for\s+\w+\s+in\b/.test(seg)) continue
    const body = seg.replace(/^(?:do|then|else|while|until|if|!)\s+/, '')
    if (!body) continue
    const words = programWords(body)
    if (words[0] === 'find' && /\s-(?:exec|execdir|delete|ok)\b/.test(body)) return { ok: false, reason: 'find with -exec or -delete is outside this role' }
    const hit = allow.some((entry) => {
      const want = entry.split(/\s+/)
      return want.every((w, i) => words[i] === w)
    })
    if (!hit) return { ok: false, reason: `"${words.slice(0, 3).join(' ')}" is not one of this role's commands` }
  }
  return { ok: true }
}

function pathWithin(cwd: string, path: string, prefixes: string[]): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const rel = relative(cwd, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const norm = rel.split(sep).join('/')
  return prefixes.some((p) => norm === p.replace(/\/$/, '') || norm.startsWith(p.endsWith('/') ? p : p + '/'))
}

// --- the gate -----------------------------------------------------------------

export type RoleFailure = 'unauthorized' | 'command' | 'path' | 'param-limit'

export type RoleVerdict =
  | { ok: true }
  | { ok: false; kind: RoleFailure; reason: string; /** A role that would have allowed this call, if any. */ wouldAllow?: string }

/** Which role would allow a call this role refused: what the owner would switch to. */
function suggestRole(roles: Map<string, RoleSpec>, current: string, check: (r: RoleSpec) => boolean): string | undefined {
  return [...roles.values()].find((r) => r.id !== current && r.id !== 'full' && check(r))?.id ?? (current === 'full' ? undefined : 'full')
}

export function checkRole(roles: Map<string, RoleSpec>, roleId: string, call: { tool: string; input: unknown; cwd: string }): RoleVerdict {
  const role = roles.get(roleId)
  if (!role) return { ok: false, kind: 'unauthorized', reason: `role "${roleId}" is not defined` }
  if (role.tools.includes('*')) return { ok: true }
  const tool = canonicalTool(call.tool)
  const o = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>

  const refuse = (kind: RoleFailure, reason: string, check: (r: RoleSpec) => boolean): RoleVerdict =>
    ({ ok: false, kind, reason, wouldAllow: suggestRole(roles, roleId, check) })

  if (!toolAllowed(role, tool)) {
    return refuse('unauthorized', `${tool} is not available to the ${roleId} role`, (r) => toolAllowed(r, tool))
  }
  if (tool === 'Bash' && typeof o.command === 'string') {
    const c = commandAllowed(role, o.command)
    if (!c.ok) return refuse('command', c.reason, (r) => toolAllowed(r, 'Bash') && commandAllowed(r, o.command as string).ok)
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = [o.file_path, o.path, o.notebook_path].find((p): p is string => typeof p === 'string')
    if (!path || !pathWithin(call.cwd, path, role.writes ?? [])) {
      return refuse('path', `${roleId} may not change ${path ?? 'that file'}${role.writes?.length ? ` (only ${role.writes.join(', ')})` : ''}`,
        (r) => toolAllowed(r, tool) && !!path && pathWithin(call.cwd, path, r.writes ?? []))
    }
  }
  const limits = role.params?.[tool]
  if (limits?.params) {
    // Only the arguments the role constrains are checked; the rest pass as-is.
    const keys = new Set(Object.keys(limits.params))
    const subset = Object.fromEntries(Object.entries(o).filter(([k]) => keys.has(k)))
    const bad = validateParams(limits, subset)
    if (bad) return { ok: false, kind: 'param-limit', reason: bad }
  }
  return { ok: true }
}

/** What the model reads when a call is refused, so its result tells the owner. */
export function refusalMessage(roleId: string, v: Extract<RoleVerdict, { ok: false }>, taskId?: string): string {
  const fix = v.wouldAllow
    ? ` If this job really needs it, say so in your result: the owner can switch it with /schedule role ${taskId ?? '<id>'} ${v.wouldAllow}.`
    : ''
  return `Refused: this scheduled job runs with the ${roleId} role, and ${v.reason}.${fix} Do not try another way to do the same thing.`
}

/**
 * For hiding what a role cannot use. Built-in tool names for the SDK's `tools`
 * option, and MCP servers (from .mcp.json) to put in `disallowedTools`.
 */
export function exposureFor(role: RoleSpec, mcpServers: string[]): { builtins: string[] | null; hiddenServers: string[] } {
  if (role.tools.includes('*')) return { builtins: null, hiddenServers: [] }
  const builtins = role.tools.filter((t) => !t.startsWith('mcp__') && !t.endsWith('*'))
  const hiddenServers = mcpServers.filter((s) => !role.tools.some((t) => t.startsWith(`mcp__${s}__`) || t === `mcp__${s}`))
  return { builtins, hiddenServers }
}

/** Server configs from .mcp.json files (nested under mcpServers or flat). Later files win. */
export function mcpServerConfigs(paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of paths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
      const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data) as Record<string, unknown>
      for (const [k, v] of Object.entries(servers)) if (v && typeof v === 'object') out[k] = v
    } catch {
      // Missing or malformed: nothing from it.
    }
  }
  return out
}

export function mcpServerNames(paths: string[]): string[] {
  return Object.keys(mcpServerConfigs(paths))
}

/** The MCP servers a role may use, out of those configured. */
export function allowedServers(role: RoleSpec, configs: Record<string, unknown>): Record<string, unknown> {
  if (role.tools.includes('*')) return configs
  return Object.fromEntries(Object.entries(configs).filter(([name]) => role.tools.some((t) => t.startsWith(`mcp__${name}__`) || t === `mcp__${name}`)))
}
