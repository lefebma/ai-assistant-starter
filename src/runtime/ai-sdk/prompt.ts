/**
 * System prompt assembly for the AI SDK runtime.
 *
 * Claude Code loads CLAUDE.md files automatically (settingSources
 * ['project', 'user'] in the claude runtime); this runtime assembles the
 * equivalent by hand: user-level ~/.claude/CLAUDE.md first, then the
 * project CLAUDE.md (project guidance wins on conflict, matching Claude
 * Code precedence), plus a small environment block the harness would
 * otherwise provide.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { installTimezone } from '../../env.js'

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Claude Code resolves @file imports in CLAUDE.md natively; setup relies on
 * that to keep the personality in its own PERSONALITY.md (`@PERSONALITY.md`
 * inside CLAUDE.md). This runtime reads the files itself, so without the same
 * resolution an API-key install would get the literal "@PERSONALITY.md" line
 * in its system prompt and no personality at all. Only whole-line imports are
 * resolved — the form setup writes — and a missing target leaves the line
 * untouched, matching Claude Code's silence about unresolvable imports. Depth
 * is capped so two files importing each other cannot recurse forever.
 */
export function resolveImports(text: string, baseDir: string, depth = 0): string {
  if (depth >= 5) return text
  return text
    .split('\n')
    .map((line) => {
      const m = /^@(\S+)$/.exec(line.trim())
      if (!m) return line
      const target = m[1].startsWith('~/') ? resolve(homedir(), m[1].slice(2)) : resolve(baseDir, m[1])
      const content = readIfExists(target)
      return content === null ? line : resolveImports(content, dirname(target), depth + 1)
    })
    .join('\n')
}

export function buildSystemPrompt(projectRoot: string): string {
  const parts: string[] = []

  parts.push(
    'You are a persistent personal assistant agent. You run as a service with tool access '
      + '(shell, file system). Follow the operating instructions below exactly; they override defaults.'
  )

  const userMd = readIfExists(resolve(homedir(), '.claude', 'CLAUDE.md'))
  if (userMd?.trim()) {
    parts.push(`# User instructions (global)\n\n${resolveImports(userMd, resolve(homedir(), '.claude')).trim()}`)
  }

  const projectMd = readIfExists(resolve(projectRoot, 'CLAUDE.md'))
  if (projectMd?.trim()) {
    parts.push(`# Project instructions\n\n${resolveImports(projectMd, projectRoot).trim()}`)
  }

  // Was pinned to America/Toronto for every install. An owner elsewhere had the
  // wrong clock stated as fact on every turn, which quietly poisons anything
  // date-shaped: "today", scheduling, "is this email recent".
  const tz = installTimezone()
  const now = new Date()
  const dateStr = now.toLocaleString('en-CA', { timeZone: tz, hour12: false })
  parts.push(
    '# Environment\n\n'
      + `- Working directory: ${projectRoot}\n`
      + `- Platform: ${platform()}\n`
      + `- Current date/time (${tz}): ${dateStr}\n`
      + `- Agent runtime: ai-sdk (direct API billing, no Claude Code harness)`
  )

  return parts.join('\n\n---\n\n')
}
